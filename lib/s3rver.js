'use strict';

const xmlParser = require('fast-xml-parser');
const Koa = require('koa');
const { defaults, isPlainObject } = require('lodash');
const he = require('he');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { callbackify, format, promisify } = require('util');

const loggerMiddleware = require('./middleware/logger');
const vhostMiddleware = require('./middleware/vhost');
const { getConfigModel } = require('./models/config');
const S3Error = require('./models/error');
const FilesystemStore = require('./stores/filesystem');
const router = require('./routes');
const { getXmlRootTag } = require('./utils');

class S3rver extends Koa {
  constructor(options) {
    super();
    this.context.onerror = onerror;
    const {
      silent,
      serviceEndpoint,
      directory,
      resetOnClose,
      allowMismatchedSignatures,
      vhostBuckets,
      configureBuckets,
      ...serverOptions
    } = defaults({}, options, S3rver.defaultOptions);
    this.serverOptions = serverOptions;
    this._configureBuckets = configureBuckets;
    this.silent = silent;
    this.resetOnClose = resetOnClose;
    this.allowMismatchedSignatures = allowMismatchedSignatures;
    this.store = this.context.store = new FilesystemStore(directory);

    // Log all requests
    this.use(loggerMiddleware(this, silent));

    try {
      // encode object responses as XML
      const parser = new xmlParser.j2xParser({
        ignoreAttributes: false,
        attrNodeName: '@',
        tagValueProcessor: (a) => he.escape(a.toString()),
      });
      this.use(async (ctx, next) => {
        await next();
        if (isPlainObject(ctx.body)) {
          ctx.type = 'application/xml';
          ctx.body =
            '<?xml version="1.0" encoding="UTF-8"?>\n' + parser.parse(ctx.body);
        }
      });

      // Express mount interop
      this.use((ctx, next) => {
        ctx.mountPath = ctx.mountPath || ctx.req.baseUrl;
        return next();
      });

      this.use(vhostMiddleware({ serviceEndpoint, vhostBuckets }));
      this.use(router.routes());
    } catch (err) {
      this.logger.exceptions.unhandle();
      this.logger.close();
      throw err;
    }
  }

  /**
   * Convenience method for configurating a set of buckets without going through
   * S3's API. Useful for quickly provisioning buckets before starting up the
   * server.
   */
  async configureBuckets() {
    return Promise.all(
      this._configureBuckets.map(async (bucket) => {
        const bucketExists = !!(await this.store.getBucket(bucket.name));
        const replacedConfigs = [];
        await this.store.putBucket(bucket.name);
        for (const configXml of bucket.configs || []) {
          const xml = configXml.toString();
          let Model;
          switch (getXmlRootTag(xml)) {
            case 'CORSConfiguration':
              Model = getConfigModel('cors');
              break;
            case 'WebsiteConfiguration':
              Model = getConfigModel('website');
              break;
          }
          if (!Model) {
            throw new Error(
              'error reading bucket config: unsupported configuration type',
            );
          }
          const config = Model.validate(xml);
          const existingConfig = await this.store.getSubresource(
            bucket.name,
            undefined,
            config.type,
          );
          await this.store.putSubresource(bucket.name, undefined, config);
          if (existingConfig) {
            replacedConfigs.push(config.type);
          }
        }
        // warn if we're updating a bucket that already exists
        if (replacedConfigs.length) {
          this.logger.warn(
            'replaced %s config for bucket "%s"',
            replacedConfigs.join(),
            bucket.name,
          );
        } else if (bucketExists) {
          this.logger.warn('the bucket "%s" already exists', bucket.name);
        }
      }),
    );
  }

  /**
   * Resets all buckets and configurations supported by the configured store.
   */
  reset() {
    this.store.reset();
  }

  /**
   * Starts the HTTP server.
   *
   * @param {Function} [callback] Function called with (err, addressObj) as arguments.
   * @returns {this|Promise} The S3rver instance. If no callback function is supplied, a Promise
   *   is returned.
   */
  run(callback) {
    const runAsync = async () => {
      await this.configureBuckets();

      const { address, port, ...listenOptions } = this.serverOptions;
      this.httpServer = await this.listen(port, address, listenOptions);
      return this.httpServer.address();
    };

    if (typeof callback === 'function') {
      callbackify(runAsync)(callback);
      return this;
    } else {
      return runAsync();
    }
  }

  listen(...args) {
    const { key, cert, pfx } = this.serverOptions;
    const server =
      (key && cert) || pfx
        ? https.createServer(this.serverOptions)
        : http.createServer(); // Node < 8.12 does not support http.createServer([options])

    const [callback] = args.slice(-1);
    server.on('request', this.callback()).on('close', () => {
      this.logger.exceptions.unhandle();
      this.logger.close();
      if (this.resetOnClose) {
        this.reset();
      }
    });
    if (typeof callback === 'function') {
      return server.listen(...args);
    } else {
      return new Promise((resolve, reject) =>
        server.listen(...args, (err) => (err ? reject(err) : resolve(server))),
      );
    }
  }

  /**
   * Proxies httpServer.close().
   *
   * @param {Function} [callback]
   * @returns {this|Promise}
   */
  close(callback) {
    if (!this.httpServer) {
      const err = new Error('Not running');
      if (typeof callback === 'function') {
        callback(err);
        return this;
      } else {
        return Promise.reject(err);
      }
    }
    if (typeof callback === 'function') {
      this.httpServer.close(callback);
      return this;
    } else {
      return promisify(this.httpServer.close.bind(this.httpServer))();
    }
  }
}
S3rver.defaultOptions = {
  address: 'localhost',
  port: 4568,
  key: undefined,
  cert: undefined,
  silent: false,
  serviceEndpoint: 'amazonaws.com',
  directory: path.join(os.tmpdir(), 's3rver'),
  resetOnClose: false,
  allowMismatchedSignatures: false,
  vhostBuckets: true,
  configureBuckets: [],
};
S3rver.prototype.getMiddleware = S3rver.prototype.callback;

module.exports = S3rver;

/**
 * Koa context.onerror handler modified to write a XML-formatted response body
 * @param {Error} err
 */
function onerror(err) {
  // don't do anything if there is no error.
  // this allows you to pass `this.onerror`
  // to node-style callbacks.
  if (err == null) return;

  if (!(err instanceof Error))
    err = new Error(format('non-error thrown: %j', err));

  let headerSent = false;
  if (this.headerSent || !this.writable) {
    headerSent = err.headerSent = true;
  }

  // delegate
  this.app.emit('error', err, this);

  // nothing we can do here other
  // than delegate to the app-level
  // handler and log.
  if (headerSent) {
    return;
  }

  const { res } = this;

  if (!(err instanceof S3Error)) {
    err = S3Error.fromError(err);
  }

  // first unset all headers
  res
    .getHeaderNames()
    .filter((name) => !name.match(/^access-control-|vary|x-amz-/i))
    .forEach((name) => res.removeHeader(name));

  // (the presence of x-amz-error-* headers needs additional research)
  // this.set(err.headers);

  // force application/xml
  this.type = 'application/xml';

  // respond
  const msg = err.toXML();
  this.status = err.status;
  this.length = Buffer.byteLength(msg);
  res.end(msg);
}
