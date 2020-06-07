'use strict';

const { escapeRegExp } = require('lodash');
const { isIP } = require('net');
const { hostname } = require('os');

/**
 * Middleware that rewrites URLs for buckets specified via subdomain or host header
 */
module.exports = ({ serviceEndpoint, vhostBuckets }) =>
  function vhost(ctx, next) {
    // prettier-ignore
    const pattern = RegExp(`^(?:(.+)\\.)?s3(-website)?([-.].+)?\\.${escapeRegExp(serviceEndpoint)}$`);
    const [match, bucket, website] = pattern.exec(ctx.hostname) || [];
    ctx.state.vhost = Boolean(bucket);
    if (match) {
      ctx.state.service = website ? 's3-website' : 's3';
      if (bucket) {
        // Rewrite path for requests to <bucket>.s3[-website][-<region>].amazonaws.com
        ctx.path = `/${bucket}${ctx.path}`;
      }
    } else {
      // if the request contains any x-amz-* headers or query string parameters,
      // consider this an SDK/CLI request
      for (const key of [
        ...Object.keys(ctx.headers),
        ...Object.keys(ctx.query),
      ]) {
        if (key.toLowerCase().startsWith('x-amz-')) {
          ctx.state.service = 's3';
          break;
        }
      }
      if (
        vhostBuckets &&
        !isIP(ctx.hostname) &&
        !['localhost', hostname()].includes(ctx.hostname)
      ) {
        ctx.state.vhost = true;
        // otherwise attempt to distinguish virtual host-style requests
        ctx.path = `/${ctx.hostname}${ctx.path}`;
      }
    }
    return next();
  };
