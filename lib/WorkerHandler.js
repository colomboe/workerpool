'use strict';

var Promise = require('./Promise');
var assign = require('object-assign');

// determine environment
var environment = require('./environment');

function ensureWorkerThreads() {
  var WorkerThreads = tryRequireWorkerThreads()
  if (!WorkerThreads) {
    throw new Error('WorkerPool: nodeWorkers = thread is not supported, Node >= 11.7.0 required')
  }

  return WorkerThreads;
}

function tryRequireWorkerThreads() {
  try {
    return require('worker_threads');
  } catch(error) {
    if (typeof error === 'object' && error !== null && error.code == 'MODULE_NOT_FOUND') {
      return null;
      // no worker_threads, fallback to sub-process based workers
    } else {
      throw error;
    }
  }
}

// get the default worker script
function getDefaultWorker() {
  if (environment.platform == 'browser') {
    // test whether the browser supports all features that we need
    if (typeof Blob === 'undefined') {
      throw new Error('Blob not supported by the browser');
    }
    if (!window.URL || typeof window.URL.createObjectURL !== 'function') {
      throw new Error('URL.createObjectURL not supported by the browser');
    }

    // use embedded worker.js
    var blob = new Blob([require('./generated/embeddedWorker')], {type: 'text/javascript'});
    return window.URL.createObjectURL(blob);
  }
  else {
    // use external worker.js in current directory
    return __dirname + '/worker.js';
  }
}

function setupBrowserWorker(script, Worker) {
  // create the web worker
  var worker = new Worker(script);

  worker.isBrowserWorker = true;
  // add node.js API to the web worker
  worker.on = function (event, callback) {
    this.addEventListener(event, function (message) {
      callback(message.data);
    });
  };
  worker.send = function (message) {
    this.postMessage(message);
  };
  return worker;
}

function setupWorkerThreadWorker(script, WorkerThreads) {
  var worker = new WorkerThreads.Worker(script, {
    stdout: false, // automatically pipe worker.STDOUT to process.STDOUT
    stderr: false  // automatically pipe worker.STDERR to process.STDERR
  });
  worker.isWorkerThread = true;
  // make the worker mimic a child_process
  worker.send = function(message) {
    this.postMessage(message);
  };

  worker.kill = function() {
    this.terminate();
  };

  worker.disconnect = function() {
    this.terminate();
  };

  return worker;
}

function setupProcessWorker(script, options, child_process) {
  // no WorkerThreads, fallback to sub-process based workers
  var worker = child_process.fork(
    script,
    options.forkArgs,
    options.forkOpts
  );

  worker.isChildProcess = true;
  return worker;
}

// add debug flags to child processes if the node inspector is active
function resolveForkOptions(opts) {
  opts = opts || {};

  var processExecArgv = process.execArgv.join(' ');
  var inspectorActive = processExecArgv.indexOf('--inspect') !== -1;
  var debugBrk = processExecArgv.indexOf('--debug-brk') !== -1;

  var execArgv = [];
  if (inspectorActive) {
    execArgv.push('--inspect=' + opts.debugPort);

    if (debugBrk) {
      execArgv.push('--debug-brk');
    }
  }

  process.execArgv.forEach(function(arg) {
    if (arg.indexOf('--max-old-space-size') > -1) {
      execArgv.push(arg)
    }
  })

  return assign({}, opts, {
    forkArgs: opts.forkArgs,
    forkOpts: assign({}, opts.forkOpts, {
      execArgv: (opts.forkOpts && opts.forkOpts.execArgv || [])
      .concat(execArgv)
    })
  });
}

/**
 * Converts a serialized error to Error
 * @param {Object} obj Error that has been serialized and parsed to object
 * @return {Error} The equivalent Error.
 */
function objectToError (obj) {
  var temp = new Error('')
  var props = Object.keys(obj)

  for (var i = 0; i < props.length; i++) {
    temp[props[i]] = obj[props[i]]
  }

  return temp
}

/**
 * A WorkerHandler controls a single worker. This worker can be a child process
 * on node.js or a WebWorker in a browser environment.
 * @param {String} [script] If no script is provided, a default worker with a
 *                          function run will be created.
 * @constructor
 */
function WorkerHandler(script, _options) {
  this.script = script || getDefaultWorker();
  var options = _options || {};
  this.debugPort = options.debugPort;

  if (environment.platform == 'browser') {
    // check whether Worker is supported by the browser
    // Workaround for a bug in PhantomJS (Or QtWebkit): https://github.com/ariya/phantomjs/issues/14534
    if (typeof Worker !== 'function' && (typeof Worker !== 'object' || typeof Worker.prototype.constructor !== 'function')) {
      throw new Error('WorkerPool: Web workers not supported by the browser');
    }

    this.worker = setupBrowserWorker(this.script, Worker);
  } else {
    var WorkerThreads;

    if (options.nodeWorker === 'thread') {
      WorkerThreads = ensureWorkerThreads();
      this.worker = setupWorkerThreadWorker(this.script, WorkerThreads);
    } else if (options.nodeWorker === 'auto') {
      WorkerThreads = tryRequireWorkerThreads();
      if (WorkerThreads) {
        this.worker = setupWorkerThreadWorker(this.script, WorkerThreads);
      } else {
        this.worker = setupProcessWorker(this.script, resolveForkOptions(options), require('child_process'));
      }
    } else {
      this.worker = setupProcessWorker(this.script, resolveForkOptions(options), require('child_process'));
    }
  }

  var me = this;

  // The ready message is only sent if the worker.add method is called (And the default script is not used)
  if (!script) {
    this.worker.ready = true;
  }

  // queue for requests that are received before the worker is ready
  this.requestQueue = [];
  this.worker.on('message', function (response) {
    if (typeof response === 'string' && response === 'ready') {
      me.worker.ready = true;
      dispatchQueuedRequests();
    } else {
      // find the task from the processing queue, and run the tasks callback
      var id = response.id;
      var task = me.processing[id];
      if (task !== undefined) {
        // remove the task from the queue
        delete me.processing[id];

        // test if we need to terminate
        if (me.terminating === true) {
          // complete worker termination if all tasks are finished
          me.terminate();
        }

        // resolve the task's promise
        if (response.error) {
          task.resolver.reject(objectToError(response.error));
        }
        else {
          task.resolver.resolve(response.result);
        }
      }
    }
  });

  // reject all running tasks on worker error
  function onError(error) {
    me.terminated = true;
    if (me.terminating && me.terminationHandler) {
      me.terminationHandler(me);
    }
    me.terminating = false;

    for (var id in me.processing) {
      if (me.processing[id] !== undefined) {
        me.processing[id].resolver.reject(error);
      }
    }
    me.processing = Object.create(null);
  }

  // send all queued requests to worker
  function dispatchQueuedRequests()
  {
    me.requestQueue.forEach(me.worker.send.bind(me.worker));
    me.requestQueue = [];
  }

  var worker = this.worker;
  // listen for worker messages error and exit
  this.worker.on('error', onError);
  this.worker.on('exit', function (exitCode, signalCode) {
    var message = 'Workerpool Worker terminated Unexpectedly\n';

    message += '    exitCode: `' + exitCode + '`\n';
    message += '    signalCode: `' + signalCode + '`\n';

    message += '    workerpool.script: `' +  me.script + '`\n';
    message += '    spawnArgs: `' +  worker.spawnargs + '`\n';
    message += '    spawnfile: `' + worker.spawnfile + '`\n'

    message += '    stdout: `' + worker.stdout + '`\n'
    message += '    stderr: `' + worker.stderr + '`\n'

    onError(new Error(message));
  });

  this.processing = Object.create(null); // queue with tasks currently in progress

  this.terminating = false;
  this.terminated = false;
  this.terminationHandler = null;
  this.lastId = 0;
}

/**
 * Get a list with methods available on the worker.
 * @return {Promise.<String[], Error>} methods
 */
WorkerHandler.prototype.methods = function () {
  return this.exec('methods');
};

/**
 * Execute a method with given parameters on the worker
 * @param {String} method
 * @param {Array} [params]
 * @param {{resolve: Function, reject: Function}} [resolver]
 * @return {Promise.<*, Error>} result
 */
WorkerHandler.prototype.exec = function(method, params, resolver) {
  if (!resolver) {
    resolver = Promise.defer();
  }

  // generate a unique id for the task
  var id = ++this.lastId;

  // register a new task as being in progress
  this.processing[id] = {
    id: id,
    resolver: resolver
  };

  // build a JSON-RPC request
  var request = {
    id: id,
    method: method,
    params: params
  };

  if (this.terminated) {
    resolver.reject(new Error('Worker is terminated'));
  } else if (this.worker.ready) {
    // send the request to the worker
    this.worker.send(request);
  } else {
    this.requestQueue.push(request);
  }

  // on cancellation, force the worker to terminate
  var me = this;
  resolver.promise
    .catch(function (error) {
      if (error instanceof Promise.CancellationError || error instanceof Promise.TimeoutError) {
        // remove this task from the queue. It is already rejected (hence this
        // catch event), and else it will be rejected again when terminating
        delete me.processing[id];

        // terminate worker
        me.terminate(true);
      } else {
        throw error;
      }
    });

  return resolver.promise;
};

/**
 * Test whether the worker is working or not
 * @return {boolean} Returns true if the worker is busy
 */
WorkerHandler.prototype.busy = function () {
  return Object.keys(this.processing).length > 0;
};

/**
 * Terminate the worker.
 * @param {boolean} [force=false]   If false (default), the worker is terminated
 *                                  after finishing all tasks currently in
 *                                  progress. If true, the worker will be
 *                                  terminated immediately.
 * @param {function} [callback=null] If provided, will be called when process terminates.
 */
WorkerHandler.prototype.terminate = function (force, callback) {
  if (force) {
    // cancel all tasks in progress
    for (var id in this.processing) {
      if (this.processing[id] !== undefined) {
        this.processing[id].resolver.reject(new Error('Worker terminated'));
      }
    }
    this.processing = Object.create(null);
  }

  if (typeof callback === 'function') {
    this.terminationHandler = callback;
  }
  if (!this.busy()) {
    // all tasks are finished. kill the worker
    if (this.worker) {
      if (typeof this.worker.kill === 'function') {
        this.worker.kill();  // child process
      }
      else if (typeof this.worker.terminate === 'function') {
        this.worker.terminate(); // web worker
      }
      else {
        throw new Error('Failed to terminate worker');
      }
      this.worker = null;
    }
    this.terminating = false;
    this.terminated = true;
    if (this.terminationHandler) {
      this.terminationHandler(this);
    }
  }
  else {
    // we can't terminate immediately, there are still tasks being executed
    this.terminating = true;
  }
};

/**
 * Terminate the worker, returning a Promise that resolves when the termination has been done.
 * @param {boolean} [force=false]   If false (default), the worker is terminated
 *                                  after finishing all tasks currently in
 *                                  progress. If true, the worker will be
 *                                  terminated immediately.
 * @param {number} [timeout]        If provided and non-zero, worker termination promise will be rejected
 *                                  after timeout if worker process has not been terminated.
 * @return {Promise.<WorkerHandler, Error>}
 */
WorkerHandler.prototype.terminateAndNotify = function (force, timeout) {
  var resolver = Promise.defer();
  if (timeout) {
    resolver.promise.timeout = timeout;
  }
  this.terminate(force, function(worker) {
    resolver.resolve(worker);
  });
  return resolver.promise;
};

module.exports = WorkerHandler;
module.exports._tryRequireWorkerThreads = tryRequireWorkerThreads;
module.exports._setupProcessWorker = setupProcessWorker;
module.exports._setupBrowserWorker = setupBrowserWorker;
module.exports._setupWorkerThreadWorker = setupWorkerThreadWorker;
module.exports.ensureWorkerThreads = ensureWorkerThreads;
