'use strict';

const status = require('statuses');
const { format } = require('util');

const { getObject } = require('../controllers/object');
const S3Error = require('../models/error');

exports = module.exports = () =>
  async function website(ctx, next) {
    ctx.redirect = ctx.request.redirect = redirect;

    // validate an incoming website redirect location if one is set
    if (ctx.get('x-amz-website-redirect-location')) {
      if (!ctx.params.key || ctx.method !== 'PUT') {
        throw new S3Error(
          'InvalidArgument',
          'x-amz-website-redirect-location is not supported for this operation.',
          { ArgumentName: 'x-amz-website-redirect-location' },
        );
      } else if (
        !/^(https?:\/)?\//.test(ctx.get('x-amz-website-redirect-location'))
      ) {
        throw new S3Error(
          'InvalidArgument',
          "The website redirect location must have a prefix of 'http://' or 'https://' or '/'.",
        );
      }
    }

    const config = await ctx.store.getSubresource(
      ctx.params.bucket,
      undefined,
      'website',
    );
    if (ctx.state.service === 's3' || (!ctx.state.service && !config)) {
      // requests to the the API endpoint use normal output behavior
      // (vhost-style buckets without website configurations also always use this behavior)
      return next();
    }

    ctx.onerror = onerror;
    ctx.state.website = config || {};

    // throw website-specific errors for requests to a .s3-website vhost
    if (ctx.state.service === 's3-website') {
      // disallow x-amz-* query params for website requests
      for (const key of Object.keys(ctx.query)) {
        if (key.toLowerCase().startsWith('x-amz-')) {
          throw new S3Error(
            'UnsupportedQuery',
            'The request contained an unsupported query string parameter.',
            { ParameterName: key },
          );
        }
      }
      if (!config) {
        throw new S3Error(
          'NoSuchWebsiteConfiguration',
          'The specified bucket does not have a website configuration',
          { BucketName: ctx.params.bucket },
        );
      }
    }

    try {
      if (!ctx.params.key) {
        throw new S3Error('NoSuchKey', '', { Key: '' });
      }
      await next();
    } catch (err) {
      if (err.code !== 'NoSuchKey') throw err;

      const key = err.detail.Key;
      const indexDocumentPrefix =
        key === '' || key.endsWith('/') ? key : key + '/';
      const indexExists = await ctx.store.existsObject(
        ctx.params.bucket,
        indexDocumentPrefix + config.indexDocumentSuffix,
      );

      if (indexExists) {
        if (key !== indexDocumentPrefix) {
          // Redirect keys that do not have a trailing slash when an index document exists
          if (ctx.state.vhost) {
            ctx.redirect(`/${key}/`);
          } else {
            // This isn't possible on real S3, but for convenience this allows website
            // redirects without setting up virtual hosts
            ctx.redirect(`/${ctx.params.bucket}/${key}/`);
          }
        } else {
          ctx.params = {
            ...ctx.params,
            key: indexDocumentPrefix + config.indexDocumentSuffix,
          };
          await getObject(ctx);
        }
      } else {
        // Only 404s are supported for RoutingRules right now, this may be a deviation from S3 behaviour but we don't
        // have a reproduction of a scenario where S3 does a redirect on a status code other than 404. If you're
        // reading this comment and you have a use-case, please raise an issue with details of your scenario. Thanks!
        const routingRule = (config.routingRules || []).find((rule) =>
          rule.shouldRedirect(key, 404),
        );
        if (!routingRule) {
          throw new S3Error('NoSuchKey', 'The specified key does not exist.', {
            Key: indexDocumentPrefix + config.indexDocumentSuffix,
          });
        }
        const location = routingRule.getRedirectLocation(key, {
          protocol: ctx.protocol,
          hostname: ctx.state.vhost
            ? ctx.host
            : `${ctx.host}/${ctx.params.bucket}`,
        });

        ctx.status = routingRule.statusCode;
        ctx.redirect(location);
      }
    } finally {
      const objectRedirectLocation = ctx.response.get(
        'x-amz-website-redirect-location',
      );
      if (objectRedirectLocation) {
        ctx.body.destroy();
        ctx.status = 301;
        ctx.remove('x-amz-website-redirect-location');
        ctx.redirect(objectRedirectLocation);
      }
    }
  };

/**
 * Overrides Koa's redirect behavior with one more closely matching S3
 *
 * @param {string} url
 */
function redirect(url) {
  // unset headers
  const { res } = this;
  res
    .getHeaderNames()
    .filter((name) => !name.match(/^access-control-|vary|x-amz-/i))
    .forEach((name) => res.removeHeader(name));

  this.set('Location', url);

  // status
  if (!status.redirect[this.status]) this.status = 302;

  if (this.status === 302) {
    const redirect = new S3Error('Found', 'Resource Found');
    redirect.description = '302 Moved Temporarily';
    this.body = redirect.toHTML();
    this.type = 'text/html';
  } else {
    this.body = '';
    this.type = '';
  }
}

/**
 * Koa context.onerror handler modified to write a HTML-formatted response body
 * @param {Error} err
 */
async function onerror(err) {
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

  // force text/html
  this.type = 'text/html';

  if (!err.description)
    err.description = `${err.status} ${status.message[err.status]}`;

  // respond
  const { website } = this.state;
  if (
    err.code !== 'NoSuchBucket' &&
    err.code !== 'UnsupportedQuery' &&
    website.errorDocumentKey
  ) {
    // attempt to serve error document
    const object = await this.store.getObject(
      this.params.bucket,
      website.errorDocumentKey,
    );
    if (object) {
      const objectRedirectLocation =
        object.metadata['x-amz-website-redirect-location'];
      if (objectRedirectLocation) {
        object.content.destroy();
        this.status = 301;
        this.redirect(objectRedirectLocation);
        res.end(this.body);
      } else {
        this.type = object.metadata['content-type'];
        this.length = object.size;
        object.content.pipe(res);
      }
      return;
    }
    this.logger.error(
      'Custom Error Document not found: ' + website.errorDocumentKey,
    );
    const errorDocumentErr = new S3Error(
      'NoSuchKey',
      'The specified key does not exist.',
      { Key: website.errorDocumentKey },
    );
    errorDocumentErr.description =
      'An Error Occurred While Attempting to Retrieve a Custom Error Document';
    err.errors.push(errorDocumentErr);
  }

  const msg = err.toHTML();
  this.status = err.status;
  this.length = Buffer.byteLength(msg);
  res.end(msg);
}
