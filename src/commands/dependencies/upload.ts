import chalk from 'chalk'
import {Command} from 'clipanion'
import {BufferedMetricsLogger} from 'datadog-metrics'
import fs from 'fs'
import path from 'path'

import {apiConstructor} from './api'
import {Payload} from './interfaces'
import {getMetricsLogger} from './metrics'
import {
  renderCommandInfo,
  renderDryRunUpload,
  renderFailedUpload,
  renderSuccessfulCommand,
  renderUpload,
} from './renderer'

export class UploadCommand extends Command {
  public static SUPPORTED_SOURCES = ['snyk']

  public static usage = Command.Usage({
    description: 'Upload dependencies graph to Datadog.',
    details: `
            This command will upload dependencies graph to Datadog in order to detect runtime vulnerabilities by Continuous Profiler.
            See README for details.
        `,
    examples: [
      [
        'Upload dependency graph generated by `snyk test --print-deps --json > ./snyk_deps.json` command',
        'datadog-ci dependencies upload ./snyk_deps.json --source snyk --service my-service --release-version 1.234',
      ],
    ],
  })

  private static INVALID_INPUT_EXIT_CODE = 1
  private static MISSING_FILE_EXIT_CODE = 2
  private static UPLOAD_ERROR_EXIT_CODE = 3

  private config = {
    apiKey: process.env.DATADOG_API_KEY,
    appKey: process.env.DATADOG_APP_KEY,
    datadogSite: process.env.DATADOG_SITE || 'datadoghq.com',
  }
  private dependenciesFilePath!: string
  private dryRun = false
  private releaseVersion?: string
  private service?: string
  private source?: string

  public async execute() {
    // Validate input
    if (!this.source) {
      this.context.stderr.write(`Missing ${chalk.red.bold('--source')} parameter.\n`)

      return UploadCommand.INVALID_INPUT_EXIT_CODE
    }
    if (UploadCommand.SUPPORTED_SOURCES.indexOf(this.source) === -1) {
      this.context.stderr.write(
        `Unsupported ${chalk.red.bold('--source')} ${this.source}. ` +
          `Supported sources are: ${chalk.green.bold(UploadCommand.SUPPORTED_SOURCES.join('", "'))}\n`
      )

      return UploadCommand.INVALID_INPUT_EXIT_CODE
    }
    if (!this.releaseVersion) {
      this.context.stderr.write(`Missing ${chalk.red.bold('--release-version')} parameter.\n`)

      return UploadCommand.INVALID_INPUT_EXIT_CODE
    }
    if (!this.service) {
      this.context.stderr.write(`Missing ${chalk.red.bold('--service')} parameter.\n`)

      return UploadCommand.INVALID_INPUT_EXIT_CODE
    }
    if (!this.config.appKey) {
      this.context.stderr.write(`Missing ${chalk.red.bold('DATADOG_APP_KEY')} in your environment.\n`)

      return UploadCommand.INVALID_INPUT_EXIT_CODE
    }
    if (!this.config.apiKey) {
      this.context.stderr.write(`Missing ${chalk.red.bold('DATADOG_API_KEY')} in your environment.\n`)

      return UploadCommand.INVALID_INPUT_EXIT_CODE
    }

    // Check if file exists (we are not validating the content of the file)
    this.dependenciesFilePath = path.normalize(this.dependenciesFilePath)
    if (!fs.existsSync(this.dependenciesFilePath)) {
      this.context.stderr.write(`Cannot find "${this.dependenciesFilePath}" file.\n`)

      return UploadCommand.MISSING_FILE_EXIT_CODE
    }

    // Upload dependencies
    const metricsLogger = getMetricsLogger(this.releaseVersion, this.service)

    this.context.stdout.write(
      renderCommandInfo(this.dependenciesFilePath!, this.releaseVersion, this.service, this.dryRun)
    )

    try {
      const initialTime = Date.now()
      const payload: Payload = {
        dependenciesFilePath: this.dependenciesFilePath,
        service: this.service,
        version: this.releaseVersion,
      }
      await this.uploadDependencies(payload, metricsLogger)
      const totalTimeSeconds = (Date.now() - initialTime) / 1000

      this.context.stdout.write(renderSuccessfulCommand(totalTimeSeconds))

      metricsLogger.gauge('duration', totalTimeSeconds)
    } catch (error) {
      this.context.stderr.write(error.message)

      return UploadCommand.UPLOAD_ERROR_EXIT_CODE
    } finally {
      metricsLogger.flush()
    }
  }

  private async uploadDependencies(payload: Payload, metricsLogger: BufferedMetricsLogger) {
    const api = apiConstructor(`https://api.${this.config.datadogSite}`, this.config.apiKey!, this.config.appKey!)

    try {
      if (this.dryRun) {
        this.context.stdout.write(renderDryRunUpload())

        return
      }

      this.context.stdout.write(renderUpload())
      await api.uploadDependencies(payload)
      metricsLogger.increment('success', 1)
    } catch (error) {
      this.context.stdout.write(renderFailedUpload(error.message))
      metricsLogger.increment('failed', 1)

      throw error
    }
  }
}

UploadCommand.addPath('dependencies', 'upload')
UploadCommand.addOption('dependenciesFilePath', Command.String({required: true}))
UploadCommand.addOption('source', Command.String('--source'))
UploadCommand.addOption('releaseVersion', Command.String('--release-version'))
UploadCommand.addOption('service', Command.String('--service'))
UploadCommand.addOption('dryRun', Command.Boolean('--dry-run'))
