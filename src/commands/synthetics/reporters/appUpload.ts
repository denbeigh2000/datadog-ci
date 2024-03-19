import chalk from 'chalk'
import ora from 'ora'

import {CommandContext} from '../../../helpers/interfaces'

import {AppUploadDetails} from '../interfaces'

import {ICONS} from './constants'

export class AppUploadReporter {
  private context: CommandContext
  private spinner?: ora.Ora
  private startTime: number

  constructor(context: CommandContext) {
    this.context = context
    this.startTime = Date.now()
  }

  public start = (appsToUpload: AppUploadDetails[], prependLineBreak = false): void => {
    this.write(`${prependLineBreak ? '\n' : ''}${appsToUpload.length} mobile application(s) to upload:\n`)
    this.write(appsToUpload.map((appToUpload) => this.getAppRepr(appToUpload)).join('\n') + '\n')
  }

  public renderProgress = (numberOfApplicationsLeft: number): void => {
    const text = `Uploading ${numberOfApplicationsLeft} application(s)…`
    this.spinner?.stop()
    this.spinner = ora({
      stream: this.context.stdout,
      text,
    })
    this.spinner.start()
  }

  public reportSuccess = (appendLineBreak = false): void => {
    this.endRendering()
    this.write(
      `${ICONS.SUCCESS} Uploaded applications in ${Math.round((Date.now() - this.startTime) / 1000)}s${
        appendLineBreak ? '\n' : ''
      }`
    )
  }

  public reportFailure = (failedApp: AppUploadDetails, appendLineBreak = false): void => {
    this.endRendering()
    this.write(
      `${ICONS.FAILED} Failed to upload application:\n${this.getAppRepr(failedApp)}${appendLineBreak ? '\n' : ''}`
    )
  }

  public endRendering = (): void => {
    this.spinner?.stop()
    delete this.spinner
  }

  private getAppRepr = (appUploadDetails: AppUploadDetails): string => {
    let versionPrepend = ''
    if (appUploadDetails.versionName) {
      versionPrepend = `Version ${chalk.dim.cyan(appUploadDetails.versionName)} - `
    }

    return `    ${versionPrepend}Application ID ${chalk.dim.cyan(appUploadDetails.appId)} - Local Path ${chalk.dim.cyan(
      appUploadDetails.appPath
    )}`
  }

  private write = (message: string): void => {
    this.context.stdout.write(message)
  }
}
