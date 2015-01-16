var expect = require('chai').expect,
  posix = require('posix'),
  shortid = require('shortid'),
  os = require('os'),
  continueProcess = require('./fixtures/continueProcess'),
  fs = require('fs'),
  async = require('async'),
  exec = require('./fixtures/exec'),
  child_process = require('child_process')

var user = posix.getpwnam(process.getuid())
var group = posix.getgrnam(process.getgid())

var config = {
  boss: {
    user: user.name,
    group: group.name,
    timeout: 5000,
    autoresume: false
  },
  remote: {
    enabled: false,

    inspector: {
      enabled: false
    }
  },
  debug: {
    daemon: false,
    cluster: false
  }
}
var logger = {
  info: console.info,
  warn: console.info,
  error: console.info,
  debug: console.info
}

var remote = require('../../lib/local').connect,
  remote = remote.bind(null, config, logger)

var boss
var tmpdir

describe('Boss', function() {
  // integration tests are slow
  this.timeout(60000)

  beforeEach(function(done) {
    tmpdir = os.tmpdir() + '/' + shortid.generate()
    tmpdir = tmpdir.replace(/\/\//g, '/')

    config.boss.logdir = tmpdir + '/logs'
    config.boss.rundir = tmpdir + '/run'
    config.boss.confdir = tmpdir + '/conf'
    config.boss.appdir = tmpdir + '/apps'

    remote(function(error, b) {
      if(error) throw error

      boss = b

      // log all received events
      boss.on('*', function(type) {
        if(type.substring(0, 'boss:log'.length) == 'boss:log' ||
          type.substring(0, 'process:uncaughtexception'.length) == 'process:uncaughtexception' ||
          type.substring(0, 'boss:fatality'.length) == 'boss:fatality' ||
          type.substring(0, 'process:log'.length) == 'process:log') {
          // already handled
          return
        }

        console.info(type)
      })
      boss.on('boss:log:*', function(type, event) {
        console.info(type, event.message)
      })
      boss.on('process:log:*', function(type, processId, event) {
        console.info(type, event)
      })
      boss.on('process:uncaughtexception:*', function(type, error) {
        console.log(error.stack)
      })
      boss.on('boss:fatality', function(error) {
        console.log(error.stack)
      })

      done()
    })
  })

  afterEach(function(done) {
    boss.callbacks = {}
    boss.kill(boss.disconnect.bind(boss, done))
  })

  it('should have npm available', function(done) {
    child_process.exec('which npm', function(error, stdout, stderr) {
      console.info('which npm')
      console.info('error', error)
      console.info('stdout', stdout)
      console.info('stderr', stderr)

      done()
    })
  })

  it('should have git available', function(done) {
    child_process.exec('which git', function(error, stdout, stderr) {
      console.info('which git')
      console.info('error', error)
      console.info('stdout', stdout)
      console.info('stderr', stderr)

      done()
    })
  })

  it('should start a process', function(done) {
    boss.startProcess(__dirname + '/fixtures/hello-world.js', {}, function(error, processInfo) {
      expect(error).to.not.exist
      expect(processInfo.id).to.be.ok

      boss.on('process:ready', function(readyProcessInfo) {
        if(readyProcessInfo.id != processInfo.id) {
          return
        }

        expect(readyProcessInfo.socket).to.include(readyProcessInfo.pid)

        done()
      })
    })
  })

  it('should survive starting a process with the wrong group name', function(done) {
    boss.startProcess(__dirname + '/fixtures/hello-world.js', {
      group: shortid.generate()
    }, function(error) {
      expect(error).to.be.ok
      expect(error.message).to.contain('group')

      done()
    })
  })

  it('should survive starting a process with the wrong user name', function(done) {
    boss.startProcess(__dirname + '/fixtures/hello-world.js', {
      user: shortid.generate()
    }, function(error) {
      expect(error).to.be.ok
      expect(error.message).to.contain('user')

      done()
    })
  })

  it('should start a process in debug mode', function(done) {
    boss.startProcess(__dirname + '/fixtures/hello-world.js', {
      debug: true
    }, function(error, processInfo) {
      expect(error).to.not.exist
      expect(processInfo.id).to.be.ok

      var continued = false

      boss.on('process:ready', function(readyProcessInfo) {
        if(readyProcessInfo.id != processInfo.id) {
          return
        }

        expect(readyProcessInfo.socket).to.include(readyProcessInfo.pid)
        expect(continued).to.be.true

        done()
      })

      expect(processInfo.status).to.equal('paused')

      continueProcess(processInfo.debugPort, function(error) {
        expect(error).to.not.exist

        continued = true
      })
    })
  })

  it('should stop a process', function(done) {
    boss.startProcess(__dirname + '/fixtures/hello-world.js', {}, function(error, processInfo) {
      expect(error).to.not.exist
      expect(processInfo.id).to.be.ok

      boss.on('process:ready', function(readyProcessInfo) {
        if(readyProcessInfo.id != processInfo.id) {
          return
        }

        expect(readyProcessInfo.socket).to.be.ok

        boss.connectToProcess(readyProcessInfo.id, function(error, remote) {
          expect(error).to.not.exist

          boss.on('process:exit', function(stoppedProcessInfo, error, code, signal) {
            if(stoppedProcessInfo.id != processInfo.id) {
              return
            }

            expect(stoppedProcessInfo.status).to.equal('stopped')
            expect(error).to.not.exist
            expect(code).to.equal(0)
            expect(signal).to.not.exist

            console.info('process exited')

            boss.listProcesses(function(error, processes) {
              expect(error).to.not.exist
              expect(processes.length).to.equal(1)
              expect(processes[0].id).to.equal(stoppedProcessInfo.id)
              expect(processes[0].status).to.equal('stopped')

              done()
            })
          })

          remote.kill()
          remote.disconnect()
        })
      })
    })
  })

  it('should restart a process', function(done) {
    boss.startProcess(__dirname + '/fixtures/hello-world.js', {}, function(error, processInfo) {
      expect(error).to.not.exist
      expect(processInfo.id).to.be.ok

      boss.once('process:ready', function(readyProcessInfo) {
        if(readyProcessInfo.id != processInfo.id) {
          return
        }

        expect(readyProcessInfo.socket).to.be.ok

        boss.connectToProcess(processInfo.id, function(error, remote) {
          expect(error).to.not.exist

          var notifiedOfRestarting = false

          boss.on('process:restarting', function(restartingProcessInfo) {
            if(restartingProcessInfo.id != processInfo.id) {
              return
            }

            notifiedOfRestarting = true
          })

          remote.restart()
          remote.disconnect()

          boss.on('process:restarted', function(restartedProcessInfo) {
            if(restartedProcessInfo.id != processInfo.id) {
              return
            }

            console.info('process restarted')

            boss.listProcesses(function(error, processes) {
              console.info(error, processes)
              expect(error).to.not.exist
              expect(notifiedOfRestarting).to.be.true
              expect(processes.length).to.equal(1)
              expect(processes[0].restarts).to.equal(1)

              done()
            })
          })
        })
      })
    })
  })

  it('should list processes', function(done) {
    boss.listProcesses(function(error, processes) {
      expect(error).to.not.exist
      expect(processes.length).to.equal(0)

      boss.startProcess(__dirname + '/fixtures/hello-world.js', {}, function(error, processInfo) {
        expect(error).to.not.exist
        expect(processInfo.id).to.be.ok

        boss.on('process:ready', function() {
          boss.listProcesses(function(error, processes) {
            expect(error).to.not.exist
            expect(processes.length).to.equal(1)

            done()
          })
        })
      })
    })
  })

  it('should restart a failing process', function(done) {
    boss.startProcess(__dirname + '/fixtures/crash-on-message.js', {}, function(error, processInfo) {
      expect(error).to.not.exist
      expect(processInfo.id).to.be.ok

      boss.once('process:ready', function(readyProcessInfo) {
        if(readyProcessInfo.id != processInfo.id) {
          return
        }

        expect(readyProcessInfo.socket).to.be.ok

        boss.connectToProcess(processInfo.id, function(error, remote) {
          expect(error).to.not.exist

          remote.send('custom:euthanise')

          boss.once('process:restarted', function(newProcessInfo, failedPid) {
            if(newProcessInfo.id != processInfo.id) {
              return
            }

            expect(newProcessInfo.id).to.equal(processInfo.id)
            expect(readyProcessInfo.pid).to.equal(failedPid)
            expect(newProcessInfo.pid).to.not.equal(failedPid)

            done()
          })
        })
      })
    })
  })

  it('should abort a constantly failing process', function(done) {
    boss.startProcess(__dirname + '/fixtures/first-tick-crash.js', {}, function(error, processInfo) {
      expect(error).to.not.exist

      boss.once('process:aborted', function(abortedProcessInfo) {
        if(abortedProcessInfo.id != processInfo.id) {
          return
        }

        // should not be in the process list
        boss.listProcesses(function(error, processes) {
          expect(error).to.not.exist
          expect(processes.length).to.equal(1)
          expect(processes[0].id).to.equal(abortedProcessInfo.id)
          expect(processes[0].status).to.equal('aborted')

          done()
        })
      })
    })
  })

  it('should invoke a remote callback', function(done) {
    boss.startProcess(__dirname + '/fixtures/remote-executor.js', {}, function (error, processInfo) {
      expect(error).to.not.exist
      expect(processInfo.id).to.be.ok

      boss.once('process:ready', function(readyProcessInfo) {
        if(readyProcessInfo.id != processInfo.id) {
          return
        }

        expect(readyProcessInfo.socket).to.be.ok

        boss.connectToProcess(processInfo.id, function(error, remote) {
          expect(error).to.not.exist

          remote.send('custom:hello', function(message) {
            expect(message).to.equal('hello world')

            remote.disconnect()
            done()
          })
        })
      })
    })
  })

  it('should start cluster and report online when all processes have started', function(done) {
    boss.startProcess(__dirname + '/fixtures/http-server.js', {
      env: {
        PORT: 0
      },
      instances: 2
    }, function (error, processInfo) {
      expect(error).to.not.exist
      expect(processInfo.id).to.be.ok

      var workersForked = 0
      var workersStarting = 0
      var workersStarted = 0
      var workersReady = 0

      boss.on('worker:forked', function(clusterProcessInfo, workerProcessInfo) {
        if(clusterProcessInfo.id != processInfo.id) {
          return
        }

        expect(workerProcessInfo).to.be.ok

        workersForked++
      })

      boss.on('worker:starting', function(clusterProcessInfo, workerProcessInfo) {
        if(clusterProcessInfo.id != processInfo.id) {
          return
        }

        expect(workerProcessInfo).to.be.ok

        workersStarting++
      })

      boss.on('worker:started', function(clusterProcessInfo, workerProcessInfo) {
        if(clusterProcessInfo.id != processInfo.id) {
          return
        }

        expect(workerProcessInfo).to.be.ok

        workersStarted++
      })

      boss.on('worker:ready', function(clusterProcessInfo, workerProcessInfo) {
        if(clusterProcessInfo.id != processInfo.id) {
          return
        }

        expect(workerProcessInfo).to.be.ok

        workersReady++
      })

      boss.once('cluster:online', function(clusterProcessInfo) {
        if(clusterProcessInfo.id != processInfo.id) {
          return
        }

        expect(workersForked).to.equal(2)
        expect(workersStarting).to.equal(2)
        expect(workersStarted).to.equal(2)
        expect(workersReady).to.equal(2)

        done()
      })
    })
  })

  it('should report status for cluster workers', function(done) {
    boss.startProcess(__dirname + '/fixtures/http-server.js', {
      env: {
        PORT: 0
      },
      instances: 2
    }, function (error, processInfo) {
      expect(error).to.not.exist
      expect(processInfo.id).to.be.ok

      boss.once('cluster:online', function(clusterProcessInfo) {
        if(clusterProcessInfo.id != processInfo.id) {
          return
        }

        boss.listProcesses(function(error, processes) {
          expect(error).to.not.exist
          expect(processes.length).to.equal(1)

          expect(processes[0].workers.length).to.equal(2)

          expect(processes[0].workers[0].title).to.equal(processes[0].workers[1].title)
          expect(processes[0].workers[0].pid).to.not.equal(processes[0].workers[1].pid)

          done()
        })
      })
    })
  })

  it('should reduce number of cluster workers', function(done) {
    var instances = os.cpus().length - 1

    boss.startProcess(__dirname + '/fixtures/http-server.js', {
      env: {
        PORT: 0
      },
      instances: instances
    }, function (error, processInfo) {
      expect(error).to.not.exist
      expect(processInfo.id).to.be.ok

      boss.once('cluster:online', function(clusterProcessInfo) {
        if(clusterProcessInfo.id != processInfo.id) {
          return
        }

        instances--

        boss.setClusterWorkers(processInfo.id, instances, function(error) {
          expect(error).to.not.exist

          boss.listProcesses(function(error, processes) {
            expect(error).to.not.exist
            expect(processes.length).to.equal(1)
            expect(processes[0].workers.length).to.equal(instances)

            boss.findProcessInfoById(processInfo.id, function(error, processInfo) {
              expect(error).to.not.exist
              expect(processInfo.instances).to.equal(instances)

              done()
            })
          })
        })
      })
    })
  })

  it('should increase number of cluster workers', function(done) {
    var instances = os.cpus().length - 2

    boss.startProcess(__dirname + '/fixtures/http-server.js', {
      env: {
        PORT: 0
      },
      instances: instances
    }, function (error, processInfo) {
      expect(error).to.not.exist
      expect(processInfo.id).to.be.ok

      boss.once('cluster:online', function (clusterProcessInfo) {
        if(clusterProcessInfo.id != processInfo.id) {
          return
        }

        instances++

        boss.setClusterWorkers(processInfo.id, instances, function (error) {
          expect(error).to.not.exist

          boss.once('cluster:online', function (clusterProcessInfo) {
            if(clusterProcessInfo.id != processInfo.id) {
              return
            }

            boss.listProcesses(function (error, processes) {
              expect(error).to.not.exist
              expect(processes.length).to.equal(1)
              expect(processes[0].workers.length).to.equal(instances)

              boss.findProcessInfoById(processInfo.id, function(error, processInfo) {
                expect(error).to.not.exist
                expect(processInfo.instances).to.equal(instances)

                done()
              })
            })
          })
        })
      })
    })
  })

  it('should dump process info', function(done) {
    boss.startProcess(__dirname + '/fixtures/hello-world.js', {}, function(error, processInfo) {
      expect(error).to.not.exist
      expect(processInfo.id).to.be.ok

      boss.once('process:ready', function(readyProcessInfo) {
        if(readyProcessInfo.id != processInfo.id) {
          return
        }

        expect(readyProcessInfo.socket).to.include(readyProcessInfo.pid)

        boss.dumpProcesses(function(error) {
          expect(error).to.not.exist
          expect(fs.existsSync(config.boss.confdir + '/processes.json')).to.be.true

          done()
        })
      })
    })
  })

  it('should restore process info', function(done) {
    fs.writeFileSync(
        config.boss.confdir + '/processes.json',
        '[{"script": "' + __dirname + '/fixtures/hello-world.js' + '", "name": "super-fun"}]'
    )

    boss.listProcesses(function(error, processes) {
      expect(error).to.not.exist
      expect(processes.length).to.equal(0)

      boss.restoreProcesses(function(error) {
        expect(error).to.not.exist

        boss.listProcesses(function(error, processes) {
          expect(processes.length).to.equal(1)
          done()
        })
      })
    })
  })

  it('should make a process do a heap dump', function(done) {
    boss.startProcess(__dirname + '/fixtures/hello-world.js', {}, function(error, processInfo) {
      expect(error).to.not.exist
      expect(processInfo.id).to.be.ok

      boss.on('process:ready', function(readyProcessInfo) {
        if(readyProcessInfo.id != processInfo.id) {
          return
        }

        expect(readyProcessInfo.socket).to.be.ok

        async.parallel([
          function(callback) {
            boss.on('process:heapdump:start', function(heapDumpProcessInfo) {
              if(heapDumpProcessInfo.id != processInfo.id) {
                return
              }

              callback()
            })
          },
          function(callback) {
            boss.on('process:heapdump:complete', function(heapDumpProcessInfo) {
              if(heapDumpProcessInfo.id != processInfo.id) {
                return
              }

              callback()
            })
          },
          function(callback) {
            boss.connectToProcess(processInfo.id, function(error, remote) {
              expect(error).to.not.exist

              remote.dumpHeap(function(error, path) {
                expect(error).to.not.exist
                expect(fs.existsSync(path)).to.be.true

                // tidy up dump file
                fs.unlinkSync(path)

                remote.kill()
                remote.disconnect()

                callback()
              })
            })
          }
        ], done)
      })
    })
  })

  it('should force a process to garbage collect', function(done) {
    boss.startProcess(__dirname + '/fixtures/hello-world.js', {}, function(error, processInfo) {
      expect(error).to.not.exist
      expect(processInfo.id).to.be.ok

      boss.on('process:ready', function(readyProcessInfo) {
        if(readyProcessInfo.id != processInfo.id) {
          return
        }

        expect(readyProcessInfo.socket, 'socket was missing').to.be.ok

        boss.connectToProcess(processInfo.id, function(error, remote) {
          expect(error, 'could not connect to process').to.not.exist

          async.parallel([
            function(callback) {
              boss.on('process:gc:start', function(gcProcessInfo) {
                if (gcProcessInfo.id != processInfo.id) {
                  return
                }

                callback()
              })
            },
            function(callback) {
              boss.on('process:gc:complete', function(gcProcessInfo) {
                if(gcProcessInfo.id != processInfo.id) {
                  return
                }

                callback()
              })
            },
            function(callback) {
              remote.forceGc(function(error) {
                expect(error, 'could not perform gc').to.not.exist

                remote.kill()
                remote.disconnect()

                callback()
              })
            }
          ], done)
        })
      })
    })
  })

  it('should deploy an application', function(done) {
    var repo = tmpdir + '/' + shortid.generate()

    async.series([
      exec.bind(null, 'mkdir', [repo]),
      exec.bind(null, 'git', ['init'], repo),
      exec.bind(null, 'git', ['config', 'user.email', 'foo@bar.com'], repo),
      exec.bind(null, 'git', ['config', 'user.name', 'foo'], repo),
      exec.bind(null, 'touch', ['file'], repo),
      exec.bind(null, 'git', ['add', '-A'], repo),
      exec.bind(null, 'git', ['commit', '-m', 'initial commit'], repo)
    ], function(error) {
      if(error) throw error

      var appName = shortid.generate()

      boss.deployApplication(appName, repo, user.name, console.info, console.error, function(error, appInfo) {
        expect(error).to.not.exist
        expect(fs.existsSync(config.boss.appdir + '/' + appInfo.id)).to.be.true

        done()
      })
    })
  })

  it('should list deployed applications', function(done) {
    var deployApp = function(callback) {
      var repo = tmpdir + '/' + shortid.generate()

      async.series([
        exec.bind(null, 'mkdir', [repo]),
        exec.bind(null, 'git', ['init'], repo),
        exec.bind(null, 'git', ['config', 'user.email', 'foo@bar.com'], repo),
        exec.bind(null, 'git', ['config', 'user.name', 'foo'], repo),
        exec.bind(null, 'touch', ['file'], repo),
        exec.bind(null, 'git', ['add', '-A'], repo),
        exec.bind(null, 'git', ['commit', '-m', 'initial commit'], repo)
      ], function(error) {
        if(error) throw error

        var appName = shortid.generate()

        boss.deployApplication(appName, repo, user.name, console.info, console.error, callback)
      })
    }

    var tasks = [deployApp, deployApp, deployApp, deployApp, deployApp]

    async.parallel(tasks, function(error, results) {
      expect(error).to.not.exist

      boss.listApplications(function(error, apps) {
        expect(error).to.not.exist
        expect(apps.length).to.equal(tasks.length)

        var found = 0

        results.forEach(function(result) {
          apps.forEach(function(app) {
            if(result.id == app.id) {
              found++
            }
          })
        })

        expect(found).to.equal(tasks.length)

        done()
      })
    })
  })

  it('should remove deployed applications', function(done) {
    var repo = tmpdir + '/' + shortid.generate()

    async.series([
      exec.bind(null, 'mkdir', [repo]),
      exec.bind(null, 'git', ['init'], repo),
      exec.bind(null, 'git', ['config', 'user.email', 'foo@bar.com'], repo),
      exec.bind(null, 'git', ['config', 'user.name', 'foo'], repo),
      exec.bind(null, 'touch', ['file'], repo),
      exec.bind(null, 'git', ['add', '-A'], repo),
      exec.bind(null, 'git', ['commit', '-m', 'initial commit'], repo)
    ], function(error) {
      if(error) throw error

      var appName = shortid.generate()

      boss.deployApplication(appName, repo, user.name, console.info, console.error, function(error, appInfo) {
        expect(error).to.not.exist
        expect(fs.existsSync(config.boss.appdir + '/' + appInfo.id)).to.be.true

        boss.listApplications(function(error, apps) {
          expect(error).to.not.exist
          expect(apps.length).to.equal(1)

          boss.removeApplication(appName, function(error) {
            expect(error).to.not.exist
            expect(fs.existsSync(config.boss.appdir + '/' + appInfo.id)).to.be.false

            boss.listApplications(function(error, apps) {
              expect(error).to.not.exist
              expect(apps.length).to.equal(0)

              done()
            })
          })
        })
      })
    })
  })

  it('should switch an application ref', function(done) {
    var repo = tmpdir + '/' + shortid.generate()

    async.series([
      exec.bind(null, 'mkdir', [repo]),
      exec.bind(null, 'git', ['init'], repo),
      exec.bind(null, 'git', ['config', 'user.email', 'foo@bar.com'], repo),
      exec.bind(null, 'git', ['config', 'user.name', 'foo'], repo),
      exec.bind(null, 'touch', ['v1'], repo),
      exec.bind(null, 'git', ['add', '-A'], repo),
      exec.bind(null, 'git', ['commit', '-m', 'v1'], repo),
      exec.bind(null, 'git', ['tag', 'v1'], repo),
      exec.bind(null, 'touch', ['v2'], repo),
      exec.bind(null, 'git', ['add', '-A'], repo),
      exec.bind(null, 'git', ['commit', '-m', 'v2'], repo),
      exec.bind(null, 'git', ['tag', 'v2'], repo),
      exec.bind(null, 'touch', ['v3'], repo),
      exec.bind(null, 'git', ['add', '-A'], repo),
      exec.bind(null, 'git', ['commit', '-m', 'v3'], repo),
      exec.bind(null, 'git', ['tag', 'v3'], repo)
    ], function(error) {
      if(error) throw error

      var appName = shortid.generate()

      boss.deployApplication(appName, repo, user.name, console.info, console.error, function(error, appInfo) {
        expect(error).to.not.exist

        // should be at latest version
        expect(fs.existsSync(config.boss.appdir + '/' + appInfo.id + '/v1')).to.be.true
        expect(fs.existsSync(config.boss.appdir + '/' + appInfo.id + '/v2')).to.be.true
        expect(fs.existsSync(config.boss.appdir + '/' + appInfo.id + '/v3')).to.be.true

        boss.switchApplicationRef(appName, 'tags/v2', console.info, console.error, function(error) {
          expect(error).to.not.exist

          // now at v2
          expect(fs.existsSync(config.boss.appdir + '/' + appInfo.id + '/v1')).to.be.true
          expect(fs.existsSync(config.boss.appdir + '/' + appInfo.id + '/v2')).to.be.true
          expect(fs.existsSync(config.boss.appdir + '/' + appInfo.id + '/v3')).to.be.false

          boss.switchApplicationRef(appName, 'tags/v1', console.info, console.error, function(error) {
            expect(error).to.not.exist

            // now at v1
            expect(fs.existsSync(config.boss.appdir + '/' + appInfo.id + '/v1')).to.be.true
            expect(fs.existsSync(config.boss.appdir + '/' + appInfo.id + '/v2')).to.be.false
            expect(fs.existsSync(config.boss.appdir + '/' + appInfo.id + '/v3')).to.be.false

            done()
          })
        })
      })
    })
  })

  it('should list available application refs', function(done) {
    var repo = tmpdir + '/' + shortid.generate()

    async.series([
      exec.bind(null, 'mkdir', [repo]),
      exec.bind(null, 'git', ['init'], repo),
      exec.bind(null, 'git', ['config', 'user.email', 'foo@bar.com'], repo),
      exec.bind(null, 'git', ['config', 'user.name', 'foo'], repo),
      exec.bind(null, 'touch', ['v1'], repo),
      exec.bind(null, 'git', ['add', '-A'], repo),
      exec.bind(null, 'git', ['commit', '-m', 'v1'], repo),
      exec.bind(null, 'git', ['tag', 'v1'], repo),
      exec.bind(null, 'touch', ['v2'], repo),
      exec.bind(null, 'git', ['add', '-A'], repo),
      exec.bind(null, 'git', ['commit', '-m', 'v2'], repo),
      exec.bind(null, 'git', ['tag', 'v2'], repo),
      exec.bind(null, 'touch', ['v3'], repo),
      exec.bind(null, 'git', ['add', '-A'], repo),
      exec.bind(null, 'git', ['commit', '-m', 'v3'], repo),
      exec.bind(null, 'git', ['tag', 'v3'], repo)
    ], function(error) {
      if(error) throw error

      var appName = shortid.generate()

      boss.deployApplication(appName, repo, user.name, console.info, console.error, function(error, appInfo) {
        expect(error).to.not.exist

        boss.listApplicationRefs(appName, function(error, refs) {
          expect(error).to.not.exist

          expect(refs.length).to.equal(6)

          expect(refs[0].name).to.equal('refs/heads/master')
          expect(refs[1].name).to.equal('refs/remotes/origin/HEAD')
          expect(refs[2].name).to.equal('refs/remotes/origin/master')
          expect(refs[3].name).to.equal('refs/tags/v1')
          expect(refs[4].name).to.equal('refs/tags/v2')
          expect(refs[5].name).to.equal('refs/tags/v3')

          done()
        })
      })
    })
  })

  it('should update application refs', function(done) {
    var repo = tmpdir + '/' + shortid.generate()

    async.series([
      exec.bind(null, 'mkdir', [repo]),
      exec.bind(null, 'git', ['init'], repo),
      exec.bind(null, 'git', ['config', 'user.email', 'foo@bar.com'], repo),
      exec.bind(null, 'git', ['config', 'user.name', 'foo'], repo),
      exec.bind(null, 'touch', ['v1'], repo),
      exec.bind(null, 'git', ['add', '-A'], repo),
      exec.bind(null, 'git', ['commit', '-m', 'v1'], repo),
      exec.bind(null, 'git', ['tag', 'v1'], repo)
    ], function(error) {
      if(error) throw error

      var appName = shortid.generate()

      boss.deployApplication(appName, repo, user.name, console.info, console.error, function(error, appInfo) {
        expect(error).to.not.exist

        boss.listApplicationRefs(appName, function(error, refs) {
          expect(error).to.not.exist

          expect(refs.length).to.equal(4)

          async.series([
            exec.bind(null, 'touch', ['v2'], repo),
            exec.bind(null, 'git', ['add', '-A'], repo),
            exec.bind(null, 'git', ['commit', '-m', 'v2'], repo),
            exec.bind(null, 'git', ['tag', 'v2'], repo),
            exec.bind(null, 'touch', ['v3'], repo),
            exec.bind(null, 'git', ['add', '-A'], repo),
            exec.bind(null, 'git', ['commit', '-m', 'v3'], repo),
            exec.bind(null, 'git', ['tag', 'v3'], repo)
          ], function(error) {
            if(error) throw error

            boss.listApplicationRefs(appName, function(error, refs) {
              expect(error).to.not.exist

              expect(refs.length).to.equal(4)

              boss.updateApplicationRefs(appName, console.info, console.error, function(error) {
                expect(error).to.not.exist

                boss.listApplicationRefs(appName, function(error, refs) {
                  expect(error).to.not.exist

                  expect(refs.length).to.equal(6)

                  done()
                })
              })
            })
          })
        })
      })
    })
  })
})