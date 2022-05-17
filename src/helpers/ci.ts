import {URL} from 'url'

import {Metadata, SpanTag, SpanTags} from './interfaces'
import {
  CI_JOB_NAME,
  CI_JOB_URL,
  CI_PIPELINE_ID,
  CI_PIPELINE_NAME,
  CI_PIPELINE_NUMBER,
  CI_PIPELINE_URL,
  CI_PROVIDER_NAME,
  CI_STAGE_NAME,
  CI_WORKSPACE_PATH,
  GIT_BRANCH,
  GIT_COMMIT_AUTHOR_DATE,
  GIT_COMMIT_AUTHOR_EMAIL,
  GIT_COMMIT_AUTHOR_NAME,
  GIT_COMMIT_COMMITTER_DATE,
  GIT_COMMIT_COMMITTER_EMAIL,
  GIT_COMMIT_COMMITTER_NAME,
  GIT_COMMIT_MESSAGE,
  GIT_REPOSITORY_URL,
  GIT_SHA,
  GIT_TAG,
} from './tags'
import {getUserCISpanTags, getUserGitSpanTags} from './user-provided-git'
import {normalizeRef, removeEmptyValues, removeUndefinedValues} from './utils'

export const CI_ENGINES = {
  APPVEYOR: 'appveyor',
  AZURE: 'azurepipelines',
  BITBUCKET: 'bitbucket',
  BITRISE: 'bitrise',
  BUILDKITE: 'buildkite',
  CIRCLECI: 'circleci',
  GITHUB: 'github',
  GITLAB: 'gitlab',
  JENKINS: 'jenkins',
  TRAVIS: 'travisci',
}

// Receives a string with the form 'John Doe <john.doe@gmail.com>'
// and returns { name: 'John Doe', email: 'john.doe@gmail.com' }
const parseEmailAndName = (emailAndName: string | undefined) => {
  if (!emailAndName) {
    return {name: '', email: ''}
  }
  let name = ''
  let email = ''
  const matchNameAndEmail = emailAndName.match(/(?:"?([^"]*)"?\s)?(?:<?(.+@[^>]+)>?)/)
  if (matchNameAndEmail) {
    name = matchNameAndEmail[1]
    email = matchNameAndEmail[2]
  }

  return {name, email}
}

const resolveTilde = (filePath: string | undefined) => {
  if (!filePath || typeof filePath !== 'string') {
    return ''
  }
  // '~/folder/path' or '~'
  if (filePath[0] === '~' && (filePath[1] === '/' || filePath.length === 1)) {
    return filePath.replace('~', process.env.HOME ?? '')
  }

  return filePath
}

const filterSensitiveInfoFromRepository = (repositoryUrl: string) => {
  if (repositoryUrl.startsWith('git@')) {
    return repositoryUrl
  }
  try {
    const {protocol, hostname, pathname} = new URL(repositoryUrl)
    if (!protocol || !hostname) {
      return repositoryUrl
    }

    return `${protocol}//${hostname}${pathname}`
  } catch (e) {
    return repositoryUrl
  }
}

export const getCISpanTags = (): SpanTags | undefined => {
  const env = process.env
  let tags: SpanTags = {}

  if (env.CIRCLECI) {
    const {
      CIRCLE_WORKFLOW_ID,
      CIRCLE_PROJECT_REPONAME,
      CIRCLE_BUILD_URL,
      CIRCLE_WORKING_DIRECTORY,
      CIRCLE_BRANCH,
      CIRCLE_TAG,
      CIRCLE_SHA1,
      CIRCLE_REPOSITORY_URL,
      CIRCLE_JOB,
    } = env

    const pipelineUrl = `https://app.circleci.com/pipelines/workflows/${CIRCLE_WORKFLOW_ID}`

    tags = {
      [CI_JOB_URL]: CIRCLE_BUILD_URL,
      [CI_PIPELINE_ID]: CIRCLE_WORKFLOW_ID,
      [CI_PIPELINE_NAME]: CIRCLE_PROJECT_REPONAME,
      [CI_PIPELINE_URL]: pipelineUrl,
      [CI_JOB_NAME]: CIRCLE_JOB,
      [CI_PROVIDER_NAME]: CI_ENGINES.CIRCLECI,
      [CI_WORKSPACE_PATH]: CIRCLE_WORKING_DIRECTORY,
      [GIT_SHA]: CIRCLE_SHA1,
      [GIT_REPOSITORY_URL]: CIRCLE_REPOSITORY_URL,
      [CIRCLE_TAG ? GIT_TAG : GIT_BRANCH]: CIRCLE_TAG || CIRCLE_BRANCH,
    }
  }

  if (env.TRAVIS) {
    const {
      TRAVIS_PULL_REQUEST_BRANCH,
      TRAVIS_BRANCH,
      TRAVIS_COMMIT,
      TRAVIS_REPO_SLUG,
      TRAVIS_TAG,
      TRAVIS_JOB_WEB_URL,
      TRAVIS_BUILD_ID,
      TRAVIS_BUILD_NUMBER,
      TRAVIS_BUILD_WEB_URL,
      TRAVIS_BUILD_DIR,
      TRAVIS_COMMIT_MESSAGE,
    } = env
    tags = {
      [CI_JOB_URL]: TRAVIS_JOB_WEB_URL,
      [CI_PIPELINE_ID]: TRAVIS_BUILD_ID,
      [CI_PIPELINE_NAME]: TRAVIS_REPO_SLUG,
      [CI_PIPELINE_NUMBER]: TRAVIS_BUILD_NUMBER,
      [CI_PIPELINE_URL]: TRAVIS_BUILD_WEB_URL,
      [CI_PROVIDER_NAME]: CI_ENGINES.TRAVIS,
      [CI_WORKSPACE_PATH]: TRAVIS_BUILD_DIR,
      [GIT_SHA]: TRAVIS_COMMIT,
      [GIT_REPOSITORY_URL]: `https://github.com/${TRAVIS_REPO_SLUG}.git`,
      [GIT_COMMIT_MESSAGE]: TRAVIS_COMMIT_MESSAGE,
    }
    const isTag = !!TRAVIS_TAG
    const ref = TRAVIS_TAG || TRAVIS_PULL_REQUEST_BRANCH || TRAVIS_BRANCH
    const refKey = isTag ? GIT_TAG : GIT_BRANCH
    tags[refKey] = ref
  }

  if (env.GITLAB_CI) {
    const {
      CI_PIPELINE_ID: GITLAB_CI_PIPELINE_ID,
      CI_PROJECT_PATH,
      CI_PIPELINE_IID,
      CI_PIPELINE_URL: GITLAB_CI_PIPELINE_URL,
      CI_PROJECT_DIR,
      CI_COMMIT_REF_NAME,
      CI_COMMIT_TAG,
      CI_COMMIT_SHA,
      CI_REPOSITORY_URL,
      CI_JOB_URL: GITLAB_CI_JOB_URL,
      CI_JOB_STAGE,
      CI_JOB_NAME: GITLAB_CI_JOB_NAME,
      CI_COMMIT_MESSAGE,
      CI_COMMIT_TIMESTAMP,
      CI_COMMIT_AUTHOR,
    } = env

    const {name, email} = parseEmailAndName(CI_COMMIT_AUTHOR)

    tags = {
      [CI_JOB_NAME]: GITLAB_CI_JOB_NAME,
      [CI_JOB_URL]: GITLAB_CI_JOB_URL,
      [CI_PIPELINE_ID]: GITLAB_CI_PIPELINE_ID,
      [CI_PIPELINE_NAME]: CI_PROJECT_PATH,
      [CI_PIPELINE_NUMBER]: CI_PIPELINE_IID,
      [CI_PIPELINE_URL]: GITLAB_CI_PIPELINE_URL && GITLAB_CI_PIPELINE_URL.replace('/-/pipelines/', '/pipelines/'),
      [CI_PROVIDER_NAME]: CI_ENGINES.GITLAB,
      [CI_WORKSPACE_PATH]: CI_PROJECT_DIR,
      [CI_STAGE_NAME]: CI_JOB_STAGE,
      [GIT_BRANCH]: CI_COMMIT_REF_NAME,
      [GIT_SHA]: CI_COMMIT_SHA,
      [GIT_REPOSITORY_URL]: CI_REPOSITORY_URL,
      [GIT_TAG]: CI_COMMIT_TAG,
      [GIT_COMMIT_MESSAGE]: CI_COMMIT_MESSAGE,
      [GIT_COMMIT_AUTHOR_NAME]: name,
      [GIT_COMMIT_AUTHOR_EMAIL]: email,
      [GIT_COMMIT_AUTHOR_DATE]: CI_COMMIT_TIMESTAMP,
    }
  }

  if (env.GITHUB_ACTIONS || env.GITHUB_ACTION) {
    const {
      GITHUB_RUN_ID,
      GITHUB_WORKFLOW,
      GITHUB_RUN_NUMBER,
      GITHUB_WORKSPACE,
      GITHUB_HEAD_REF,
      GITHUB_REF,
      GITHUB_SHA,
      GITHUB_REPOSITORY,
      GITHUB_SERVER_URL,
    } = env
    const repositoryUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}.git`
    let pipelineURL = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`

    // Some older versions of enterprise might not have this yet.
    if (env.GITHUB_RUN_ATTEMPT) {
      pipelineURL += `/attempts/${env.GITHUB_RUN_ATTEMPT}`
    }

    const ref = GITHUB_HEAD_REF || GITHUB_REF || ''
    const refKey = ref.includes('tags') ? GIT_TAG : GIT_BRANCH

    tags = {
      [CI_JOB_URL]: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/commit/${GITHUB_SHA}/checks`,
      [CI_PIPELINE_ID]: GITHUB_RUN_ID,
      [CI_PIPELINE_NAME]: GITHUB_WORKFLOW,
      [CI_PIPELINE_NUMBER]: GITHUB_RUN_NUMBER,
      [CI_PIPELINE_URL]: pipelineURL,
      [CI_PROVIDER_NAME]: CI_ENGINES.GITHUB,
      [CI_WORKSPACE_PATH]: GITHUB_WORKSPACE,
      [GIT_SHA]: GITHUB_SHA,
      [GIT_REPOSITORY_URL]: repositoryUrl,
      [refKey]: ref,
    }
  }

  if (env.JENKINS_URL) {
    const {
      WORKSPACE,
      BUILD_TAG,
      JOB_NAME,
      BUILD_NUMBER,
      BUILD_URL,
      GIT_BRANCH: JENKINS_GIT_BRANCH,
      GIT_COMMIT,
      GIT_URL,
      GIT_URL_1,
    } = env

    tags = {
      [CI_PIPELINE_ID]: BUILD_TAG,
      [CI_PIPELINE_NUMBER]: BUILD_NUMBER,
      [CI_PIPELINE_URL]: BUILD_URL,
      [CI_PROVIDER_NAME]: CI_ENGINES.JENKINS,
      [CI_WORKSPACE_PATH]: WORKSPACE,
      [GIT_SHA]: GIT_COMMIT,
      [GIT_REPOSITORY_URL]: GIT_URL || GIT_URL_1,
    }
    const isTag = JENKINS_GIT_BRANCH && JENKINS_GIT_BRANCH.includes('tags')
    const refKey = isTag ? GIT_TAG : GIT_BRANCH
    const ref = normalizeRef(JENKINS_GIT_BRANCH)

    tags[refKey] = ref

    let finalPipelineName = ''
    if (JOB_NAME) {
      // Job names can contain parameters, e.g. jobName/KEY1=VALUE1,KEY2=VALUE2/branchName
      const jobNameAndParams = JOB_NAME.split('/')
      if (jobNameAndParams.length > 1 && jobNameAndParams[1].includes('=')) {
        finalPipelineName = jobNameAndParams[0]
      } else {
        finalPipelineName = JOB_NAME.replace(`/${ref}`, '')
      }
      tags[CI_PIPELINE_NAME] = finalPipelineName
    }
  }

  if (env.BUILDKITE) {
    const {
      BUILDKITE_BRANCH,
      BUILDKITE_COMMIT,
      BUILDKITE_REPO,
      BUILDKITE_TAG,
      BUILDKITE_BUILD_ID,
      BUILDKITE_PIPELINE_SLUG,
      BUILDKITE_BUILD_NUMBER,
      BUILDKITE_BUILD_URL,
      BUILDKITE_JOB_ID,
      BUILDKITE_BUILD_CHECKOUT_PATH,
      BUILDKITE_BUILD_AUTHOR,
      BUILDKITE_BUILD_AUTHOR_EMAIL,
      BUILDKITE_MESSAGE,
    } = env

    const ref = BUILDKITE_TAG || BUILDKITE_BRANCH
    const refKey = BUILDKITE_TAG ? GIT_TAG : GIT_BRANCH

    tags = {
      [CI_PROVIDER_NAME]: CI_ENGINES.BUILDKITE,
      [CI_PIPELINE_ID]: BUILDKITE_BUILD_ID,
      [CI_PIPELINE_NAME]: BUILDKITE_PIPELINE_SLUG,
      [CI_PIPELINE_NUMBER]: BUILDKITE_BUILD_NUMBER,
      [CI_PIPELINE_URL]: BUILDKITE_BUILD_URL,
      [CI_JOB_URL]: `${BUILDKITE_BUILD_URL}#${BUILDKITE_JOB_ID}`,
      [GIT_SHA]: BUILDKITE_COMMIT,
      [CI_WORKSPACE_PATH]: BUILDKITE_BUILD_CHECKOUT_PATH,
      [GIT_REPOSITORY_URL]: BUILDKITE_REPO,
      [refKey]: ref,
      [GIT_COMMIT_AUTHOR_NAME]: BUILDKITE_BUILD_AUTHOR,
      [GIT_COMMIT_AUTHOR_EMAIL]: BUILDKITE_BUILD_AUTHOR_EMAIL,
      [GIT_COMMIT_MESSAGE]: BUILDKITE_MESSAGE,
    }
  }

  if (env.BITRISE_BUILD_SLUG) {
    const {
      BITRISE_GIT_COMMIT,
      GIT_CLONE_COMMIT_HASH,
      BITRISEIO_GIT_BRANCH_DEST,
      BITRISE_GIT_BRANCH,
      BITRISE_BUILD_SLUG,
      BITRISE_TRIGGERED_WORKFLOW_ID,
      BITRISE_BUILD_NUMBER,
      BITRISE_BUILD_URL,
      BITRISE_SOURCE_DIR,
      GIT_REPOSITORY_URL: BITRISE_GIT_REPOSITORY_URL,
      BITRISE_GIT_TAG,
      BITRISE_GIT_MESSAGE,
    } = env

    const isTag = !!BITRISE_GIT_TAG
    const refKey = isTag ? GIT_TAG : GIT_BRANCH
    const ref = BITRISE_GIT_TAG || BITRISEIO_GIT_BRANCH_DEST || BITRISE_GIT_BRANCH

    tags = {
      [CI_PROVIDER_NAME]: CI_ENGINES.BITRISE,
      [CI_PIPELINE_ID]: BITRISE_BUILD_SLUG,
      [CI_PIPELINE_NAME]: BITRISE_TRIGGERED_WORKFLOW_ID,
      [CI_PIPELINE_NUMBER]: BITRISE_BUILD_NUMBER,
      [CI_PIPELINE_URL]: BITRISE_BUILD_URL,
      [GIT_SHA]: BITRISE_GIT_COMMIT || GIT_CLONE_COMMIT_HASH,
      [GIT_REPOSITORY_URL]: BITRISE_GIT_REPOSITORY_URL,
      [CI_WORKSPACE_PATH]: BITRISE_SOURCE_DIR,
      [refKey]: ref,
      [GIT_COMMIT_MESSAGE]: BITRISE_GIT_MESSAGE,
    }
  }

  if (env.BITBUCKET_COMMIT) {
    const {
      BITBUCKET_REPO_FULL_NAME,
      BITBUCKET_BUILD_NUMBER,
      BITBUCKET_BRANCH,
      BITBUCKET_COMMIT,
      BITBUCKET_GIT_SSH_ORIGIN,
      BITBUCKET_TAG,
      BITBUCKET_PIPELINE_UUID,
      BITBUCKET_CLONE_DIR,
    } = env

    const url = `https://bitbucket.org/${BITBUCKET_REPO_FULL_NAME}/addon/pipelines/home#!/results/${BITBUCKET_BUILD_NUMBER}`

    tags = {
      [CI_PROVIDER_NAME]: CI_ENGINES.BITBUCKET,
      [GIT_SHA]: BITBUCKET_COMMIT,
      [CI_PIPELINE_NUMBER]: BITBUCKET_BUILD_NUMBER,
      [CI_PIPELINE_NAME]: BITBUCKET_REPO_FULL_NAME,
      [CI_JOB_URL]: url,
      [CI_PIPELINE_URL]: url,
      [GIT_BRANCH]: BITBUCKET_BRANCH,
      [GIT_TAG]: BITBUCKET_TAG,
      [GIT_REPOSITORY_URL]: BITBUCKET_GIT_SSH_ORIGIN,
      [CI_WORKSPACE_PATH]: BITBUCKET_CLONE_DIR,
      [CI_PIPELINE_ID]: BITBUCKET_PIPELINE_UUID && BITBUCKET_PIPELINE_UUID.replace(/{|}/gm, ''),
    }
  }

  if (env.TF_BUILD) {
    const {
      BUILD_SOURCESDIRECTORY,
      BUILD_BUILDID,
      BUILD_DEFINITIONNAME,
      SYSTEM_TEAMFOUNDATIONSERVERURI,
      SYSTEM_TEAMPROJECTID,
      SYSTEM_JOBID,
      SYSTEM_TASKINSTANCEID,
      SYSTEM_PULLREQUEST_SOURCEBRANCH,
      BUILD_SOURCEBRANCH,
      BUILD_SOURCEBRANCHNAME,
      SYSTEM_PULLREQUEST_SOURCECOMMITID,
      SYSTEM_PULLREQUEST_SOURCEREPOSITORYURI,
      BUILD_REPOSITORY_URI,
      BUILD_SOURCEVERSION,
      BUILD_REQUESTEDFORID,
      BUILD_REQUESTEDFOREMAIL,
      BUILD_SOURCEVERSIONMESSAGE,
      SYSTEM_STAGEDISPLAYNAME,
      SYSTEM_JOBDISPLAYNAME,
    } = env

    const ref = SYSTEM_PULLREQUEST_SOURCEBRANCH || BUILD_SOURCEBRANCH || BUILD_SOURCEBRANCHNAME
    const refKey = (ref || '').includes('tags') ? GIT_TAG : GIT_BRANCH

    tags = {
      [CI_PROVIDER_NAME]: CI_ENGINES.AZURE,
      [CI_PIPELINE_ID]: BUILD_BUILDID,
      [CI_PIPELINE_NAME]: BUILD_DEFINITIONNAME,
      [CI_PIPELINE_NUMBER]: BUILD_BUILDID,
      [GIT_SHA]: SYSTEM_PULLREQUEST_SOURCECOMMITID || BUILD_SOURCEVERSION,
      [CI_WORKSPACE_PATH]: BUILD_SOURCESDIRECTORY,
      [GIT_REPOSITORY_URL]: SYSTEM_PULLREQUEST_SOURCEREPOSITORYURI || BUILD_REPOSITORY_URI,
      [refKey]: ref,
      [GIT_COMMIT_AUTHOR_NAME]: BUILD_REQUESTEDFORID,
      [GIT_COMMIT_AUTHOR_EMAIL]: BUILD_REQUESTEDFOREMAIL,
      [GIT_COMMIT_MESSAGE]: BUILD_SOURCEVERSIONMESSAGE,
      [CI_STAGE_NAME]: SYSTEM_STAGEDISPLAYNAME,
      [CI_JOB_NAME]: SYSTEM_JOBDISPLAYNAME,
    }

    if (SYSTEM_TEAMFOUNDATIONSERVERURI && SYSTEM_TEAMPROJECTID && BUILD_BUILDID) {
      const baseUrl = `${SYSTEM_TEAMFOUNDATIONSERVERURI}${SYSTEM_TEAMPROJECTID}/_build/results?buildId=${BUILD_BUILDID}`
      const pipelineUrl = baseUrl
      const jobUrl = `${baseUrl}&view=logs&j=${SYSTEM_JOBID}&t=${SYSTEM_TASKINSTANCEID}`

      tags = {
        ...tags,
        [CI_PIPELINE_URL]: pipelineUrl,
        [CI_JOB_URL]: jobUrl,
      }
    }
  }

  if (env.APPVEYOR) {
    const {
      APPVEYOR_REPO_NAME,
      APPVEYOR_REPO_PROVIDER,
      APPVEYOR_BUILD_FOLDER,
      APPVEYOR_BUILD_ID,
      APPVEYOR_BUILD_NUMBER,
      APPVEYOR_REPO_COMMIT,
      APPVEYOR_PULL_REQUEST_HEAD_REPO_BRANCH,
      APPVEYOR_REPO_BRANCH,
      APPVEYOR_REPO_TAG_NAME,
      APPVEYOR_REPO_COMMIT_AUTHOR,
      APPVEYOR_REPO_COMMIT_AUTHOR_EMAIL,
      APPVEYOR_REPO_COMMIT_MESSAGE_EXTENDED,
    } = env

    const pipelineUrl = `https://ci.appveyor.com/project/${APPVEYOR_REPO_NAME}/builds/${APPVEYOR_BUILD_ID}`

    tags = {
      [CI_PROVIDER_NAME]: CI_ENGINES.APPVEYOR,
      [CI_PIPELINE_URL]: pipelineUrl,
      [CI_PIPELINE_ID]: APPVEYOR_BUILD_ID,
      [CI_PIPELINE_NAME]: APPVEYOR_REPO_NAME,
      [CI_PIPELINE_NUMBER]: APPVEYOR_BUILD_NUMBER,
      [CI_JOB_URL]: pipelineUrl,
      [CI_WORKSPACE_PATH]: APPVEYOR_BUILD_FOLDER,
      [GIT_COMMIT_AUTHOR_NAME]: APPVEYOR_REPO_COMMIT_AUTHOR,
      [GIT_COMMIT_AUTHOR_EMAIL]: APPVEYOR_REPO_COMMIT_AUTHOR_EMAIL,
      [GIT_COMMIT_MESSAGE]: APPVEYOR_REPO_COMMIT_MESSAGE_EXTENDED,
    }

    if (APPVEYOR_REPO_PROVIDER === 'github') {
      const refKey = APPVEYOR_REPO_TAG_NAME ? GIT_TAG : GIT_BRANCH
      const ref = APPVEYOR_REPO_TAG_NAME || APPVEYOR_PULL_REQUEST_HEAD_REPO_BRANCH || APPVEYOR_REPO_BRANCH
      tags = {
        ...tags,
        [GIT_REPOSITORY_URL]: `https://github.com/${APPVEYOR_REPO_NAME}.git`,
        [GIT_SHA]: APPVEYOR_REPO_COMMIT,
        [refKey]: ref,
      }
    }
  }

  if (tags[CI_WORKSPACE_PATH]) {
    tags[CI_WORKSPACE_PATH] = resolveTilde(tags[CI_WORKSPACE_PATH]!)
  }
  if (tags[GIT_REPOSITORY_URL]) {
    tags[GIT_REPOSITORY_URL] = filterSensitiveInfoFromRepository(tags[GIT_REPOSITORY_URL]!)
  }
  if (tags[GIT_BRANCH]) {
    tags[GIT_BRANCH] = normalizeRef(tags[GIT_BRANCH]!)
  }
  if (tags[GIT_TAG]) {
    tags[GIT_TAG] = normalizeRef(tags[GIT_TAG]!)
  }

  return removeEmptyValues(tags)
}

export const getCIMetadata = (tagSizeLimits?: {[key in keyof SpanTags]?: number}): Metadata | undefined => {
  const tags = {
    ...getCISpanTags(),
    ...getUserCISpanTags(),
    ...getUserGitSpanTags(),
  }

  if (!tags || !Object.keys(tags).length) {
    return
  }

  if (tagSizeLimits) {
    for (const key of Object.keys(tagSizeLimits)) {
      const tagToLimit = key as SpanTag
      const originalTag = tags[tagToLimit]
      if (!!originalTag) {
        tags[tagToLimit] = originalTag.substring(0, tagSizeLimits[tagToLimit])
      }
    }
  }

  const metadata: Metadata = {
    ci: removeUndefinedValues({
      job: removeUndefinedValues({
        name: tags[CI_JOB_NAME],
        url: tags[CI_JOB_URL],
      }),
      pipeline: removeUndefinedValues({
        id: tags[CI_PIPELINE_ID],
        name: tags[CI_PIPELINE_NAME],
        number: parsePipelineNumber(tags[CI_PIPELINE_NUMBER]),
        url: tags[CI_PIPELINE_URL],
      }),
      provider: removeUndefinedValues({
        name: tags[CI_PROVIDER_NAME],
      }),
      stage: removeUndefinedValues({
        name: tags[CI_STAGE_NAME],
      }),
      workspace_path: tags[CI_WORKSPACE_PATH],
    }),

    git: removeUndefinedValues({
      branch: tags[GIT_BRANCH],
      commit: removeUndefinedValues({
        author: removeUndefinedValues({
          date: tags[GIT_COMMIT_AUTHOR_DATE],
          email: tags[GIT_COMMIT_AUTHOR_EMAIL],
          name: tags[GIT_COMMIT_AUTHOR_NAME],
        }),
        committer: removeUndefinedValues({
          date: tags[GIT_COMMIT_COMMITTER_DATE],
          email: tags[GIT_COMMIT_COMMITTER_EMAIL],
          name: tags[GIT_COMMIT_COMMITTER_NAME],
        }),
        message: tags[GIT_COMMIT_MESSAGE],
        sha: tags[GIT_SHA],
      }),
      repository_url: tags[GIT_REPOSITORY_URL],
      tag: tags[GIT_TAG],
    }),
  }

  return metadata
}

const parsePipelineNumber = (pipelineNumberStr: string | undefined): number | undefined => {
  if (pipelineNumberStr) {
    const pipelineNumber = parseInt(pipelineNumberStr, 10)

    return isFinite(pipelineNumber) ? pipelineNumber : undefined
  }
}

export const getCIEnv = (): {ciEnv: Record<string, string>; provider: string} => {
  if (process.env.CIRCLECI) {
    return {
      ciEnv: getEnvVars('CIRCLE_'),
      provider: 'circleci',
    }
  }

  if (process.env.GITLAB_CI) {
    return {
      ciEnv: getEnvVars('CI_'),
      provider: 'gitlab',
    }
  }

  if (process.env.GITHUB_ACTIONS || process.env.GITHUB_ACTION) {
    return {
      ciEnv: getEnvVars('GITHUB_'),
      provider: 'github',
    }
  }

  if (process.env.BUILDKITE) {
    return {
      ciEnv: getEnvVars('BUILDKITE_'),
      provider: 'buildkite',
    }
  }

  throw new Error('Only providers [GitHub, GitLab, CircleCI, Buildkite] are supported')
}

const getEnvVars = (prefix: string): Record<string, string> =>
  Object.entries(process.env)
    .filter(([key, value]) => key.startsWith(prefix) && !/(PASS)|(TOKEN)|(SECRET)|(KEY)/i.test(key))
    .reduce((accum, [key, value]) => ({...accum, [key]: value}), {})
