import {getProxyAgent} from '../../helpers/utils'

import {APIHelper, getApiHelper, isForbiddenError} from './api'
import {
  moveLocationsToTestOverrides,
  replaceGlobalWithDefaultTestOverrides,
  replacePollingTimeoutWithBatchTimeout,
} from './compatibility'
import {CiError, CriticalError, BatchTimeoutRunawayError} from './errors'
import {
  MainReporter,
  Reporter,
  Result,
  RunTestsCommandConfig,
  Suite,
  Summary,
  SupportedReporter,
  Test,
  TestPayload,
  Trigger,
  TriggerConfig,
  WrapperConfig,
} from './interfaces'
import {DefaultReporter, getTunnelReporter} from './reporters/default'
import {JUnitReporter} from './reporters/junit'
import {DEFAULT_BATCH_TIMEOUT, DEFAULT_COMMAND_CONFIG} from './run-tests-command'
import {getTestConfigs, getTestsFromSearchQuery} from './test'
import {Tunnel} from './tunnel'
import {
  getReporter,
  getOrgSettings,
  getTestsToTrigger,
  InitialSummary,
  renderResults,
  runTests,
  waitForResults,
  getExitReason,
  toExitCode,
  reportExitLogs,
} from './utils/public'

type ExecuteOptions = {
  jUnitReport?: string
  reporters?: (SupportedReporter | Reporter)[]
  runId?: string
  suites?: Suite[]
}

export const executeTests = async (
  reporter: MainReporter,
  config: RunTestsCommandConfig,
  suites?: Suite[]
): Promise<{
  results: Result[]
  summary: Summary
}> => {
  const api = getApiHelper(config)
  let tunnel: Tunnel | undefined
  let triggerConfigs: TriggerConfig[] = []

  const stopTunnel = async () => {
    if (tunnel) {
      await tunnel.stop()
    }
  }

  // TODO SYNTH-12989: Clean up deprecated `global` in favor of `defaultTestOverrides`
  config = replaceGlobalWithDefaultTestOverrides(config, reporter, true)

  // TODO SYNTH-12989: Clean up `locations` that should only be part of test overrides
  config = moveLocationsToTestOverrides(config, reporter, true)

  // TODO SYNTH-12989: Clean up deprecated `pollingTimeout` in favor of `batchTimeout`
  config.batchTimeout = replacePollingTimeoutWithBatchTimeout(config, reporter, true)

  try {
    triggerConfigs = await getTriggerConfigs(api, config, reporter, suites)
  } catch (error) {
    throw new CriticalError(isForbiddenError(error) ? 'AUTHORIZATION_ERROR' : 'UNAVAILABLE_TEST_CONFIG', error.message)
  }

  if (triggerConfigs.length === 0) {
    throw new CiError('NO_TESTS_TO_RUN')
  }

  let testsToTriggerResult: {
    initialSummary: InitialSummary
    overriddenTestsToTrigger: TestPayload[]
    tests: Test[]
  }

  try {
    const triggerFromSearch = !!config.testSearchQuery
    testsToTriggerResult = await getTestsToTrigger(
      api,
      triggerConfigs,
      reporter,
      triggerFromSearch,
      config.failOnMissingTests,
      config.tunnel
    )
  } catch (error) {
    if (error instanceof CiError) {
      throw error
    }

    throw new CriticalError(isForbiddenError(error) ? 'AUTHORIZATION_ERROR' : 'UNAVAILABLE_TEST_CONFIG', error.message)
  }

  const {tests, overriddenTestsToTrigger, initialSummary} = testsToTriggerResult

  // All tests have been skipped or are missing.
  if (!tests.length) {
    throw new CiError('NO_TESTS_TO_RUN')
  }

  const publicIdsToTrigger = tests.map(({public_id}) => public_id)

  if (config.tunnel) {
    let presignedURL: string
    try {
      // Get the pre-signed URL to connect to the tunnel service
      presignedURL = (await api.getTunnelPresignedURL(publicIdsToTrigger)).url
    } catch (error) {
      throw new CriticalError('UNAVAILABLE_TUNNEL_CONFIG', error.message)
    }
    // Open a tunnel to Datadog
    try {
      const tunnelProxyAgent = getProxyAgent(config.proxy)
      const tunnelReporter = getTunnelReporter(reporter)
      tunnel = new Tunnel(presignedURL, publicIdsToTrigger, tunnelProxyAgent, tunnelReporter)

      const tunnelInfo = await tunnel.start()
      overriddenTestsToTrigger.forEach((testToTrigger) => {
        testToTrigger.tunnel = tunnelInfo
      })
    } catch (error) {
      await stopTunnel()
      throw new CriticalError('TUNNEL_START_FAILED', error.message)
    }
  }

  let trigger: Trigger
  try {
    trigger = await runTests(api, overriddenTestsToTrigger, config.selectiveRerun, config.batchTimeout)
  } catch (error) {
    await stopTunnel()
    throw new CriticalError('TRIGGER_TESTS_FAILED', error.message)
  }

  if (trigger.selective_rerun_rate_limited) {
    reporter.error('The selective re-run feature was rate-limited. All tests will be re-run.\n\n')
  }

  try {
    // TODO SYNTH-12989: Remove the `maxPollingTimeout` calculation when `pollingTimeout` is removed
    const maxPollingTimeout = Math.max(
      ...triggerConfigs.map(
        (t) => config.batchTimeout || t.testOverrides?.pollingTimeout || config.pollingTimeout || DEFAULT_BATCH_TIMEOUT
      )
    )
    const {datadogSite, failOnCriticalErrors, failOnTimeout, subdomain} = config

    const results = await waitForResults(
      api,
      trigger,
      tests,
      {datadogSite, failOnCriticalErrors, failOnTimeout, subdomain, batchTimeout: maxPollingTimeout},
      reporter,
      tunnel
    )

    return {
      results,
      summary: {
        ...initialSummary,
        batchId: trigger.batch_id,
      },
    }
  } catch (error) {
    if (error instanceof BatchTimeoutRunawayError) {
      throw error
    }

    throw new CriticalError('POLL_RESULTS_FAILED', error.message)
  } finally {
    await stopTunnel()
  }
}

export const getTriggerConfigs = async (
  api: APIHelper,
  config: RunTestsCommandConfig,
  reporter: MainReporter,
  suites?: Suite[]
): Promise<TriggerConfig[]> => {
  // Grab the test config overrides from all the sources: default test config overrides, test files containing specific test config override, env variable, and CLI params
  const defaultTestConfigOverrides = config.defaultTestOverrides
  const testsFromTestConfigs = await getTestConfigs(config, reporter, suites)

  // Grab the tests returned by the search query (or `[]` if not given).
  const testsFromSearchQuery = await getTestsFromSearchQuery(api, config)

  // Grab the list of publicIds of tests to trigger from config file/env variable/CLI params, search query or test config files
  const testIdsFromCli = config.publicIds
  const testIdsFromSearchQuery = testsFromSearchQuery.map(({id}) => id)
  const testIdsFromTestConfigs = testsFromTestConfigs.map(({id}) => id)

  // Take the list of tests from the first source that defines it, by order of precedence
  const testIdsToTrigger =
    [testIdsFromCli, testIdsFromSearchQuery, testIdsFromTestConfigs].find((ids) => ids.length > 0) ?? []

  // Create the overrides required for the list of tests to trigger
  const triggerConfigs = testIdsToTrigger.map((id) => {
    const testIndexFromSearchQuery = testsFromSearchQuery.findIndex((test) => test.id === id)
    let testFromSearchQuery
    if (testIndexFromSearchQuery >= 0) {
      testFromSearchQuery = testsFromSearchQuery.splice(testIndexFromSearchQuery, 1)[0]
    }

    const testIndexFromTestConfigs = testsFromTestConfigs.findIndex((test) => test.id === id)
    let testFromTestConfigs
    if (testIndexFromTestConfigs >= 0) {
      testFromTestConfigs = testsFromTestConfigs.splice(testIndexFromTestConfigs, 1)[0]
    }

    return {
      id,
      ...testFromSearchQuery,
      ...testFromTestConfigs,
      testOverrides: {
        ...defaultTestConfigOverrides,
        ...testFromTestConfigs?.testOverrides,
      },
    }
  })

  return triggerConfigs
}

export const executeWithDetails = async (
  runConfig: WrapperConfig,
  {jUnitReport, reporters, runId, suites}: ExecuteOptions
): Promise<{
  results: Result[]
  summary: Summary
  exitCode: 0 | 1
}> => {
  const startTime = Date.now()
  const localConfig = {
    ...DEFAULT_COMMAND_CONFIG,
    ...runConfig,
  }

  // Handle reporters for the run.
  const localReporters: Reporter[] = []
  // If the config asks for specific reporters.
  if (reporters) {
    for (const reporter of reporters) {
      // Add our own reporters if required.
      if (reporter === 'junit') {
        localReporters.push(
          new JUnitReporter({
            context: process,
            jUnitReport: jUnitReport || './junit.xml',
            runName: `Run ${runId || 'undefined'}`,
          })
        )
      }
      if (reporter === 'default') {
        localReporters.push(new DefaultReporter({context: process}))
      }
      // This is a custom reporter, so simply add it.
      if (typeof reporter !== 'string') {
        localReporters.push(reporter)
      }
    }
  } else {
    localReporters.push(new DefaultReporter({context: process}))
  }

  const mainReporter = getReporter(localReporters)
  const {results, summary} = await executeTests(mainReporter, localConfig, suites)

  const orgSettings = await getOrgSettings(mainReporter, localConfig)

  renderResults({
    config: localConfig,
    reporter: mainReporter,
    results,
    orgSettings,
    startTime,
    summary,
  })

  reportExitLogs(mainReporter, localConfig, {results})

  const exitCode = toExitCode(getExitReason(localConfig, {results}))

  return {
    results,
    summary,
    exitCode,
  }
}

export const execute = async (runConfig: WrapperConfig, executeOptions: ExecuteOptions): Promise<0 | 1> => {
  const {exitCode} = await executeWithDetails(runConfig, executeOptions)

  return exitCode
}
