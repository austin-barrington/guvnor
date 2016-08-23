'use strict'

const execFile = require('mz/child_process').execFile
const config = require('./config')
const operations = require('../')
const DEBUG = require('good-enough').DEBUG
const CONTEXT = 'operations:systemd:stop-process'

module.exports = function systemdStopProcess (context, name, callback) {
  context.log([DEBUG, CONTEXT], `running systemctl stop ${config.DAEMON_NAME}.${name}`)

  return execFile(config.SYSTEMCTL_PATH, ['stop', `${config.DAEMON_NAME}.${name}`])
  .then(result => {
    if (result[0] && result[0].trim) {
      context.log([DEBUG, CONTEXT], result[0].trim())
    }

    return operations.findProcess(context, name)
  })
}