"use strict";

const net = require("net");

/**
 * Middleware that rewrites URLs for buckets specified via subdomain or host header
 */
module.exports = () =>
  function vhost(ctx, next) {
    const [match, bucket] =
      /^(?:(.+))?\.s3(-website)?([-.].+)?\.amazonaws\.com$/.exec(
        ctx.hostname
      ) || [];

    if (match) {
      // Handle requests for <bucket>.s3[-website][-<region>].amazonaws.com, if they arrive.
      if (bucket) {
        ctx.path = `/${bucket}${ctx.path}`;
      }
    } else if (!net.isIP(ctx.hostname) && ctx.hostname !== "localhost") {
      // resolves situations where the baseUrl isn't being included
      // including ctx.hostname is NOT consistent with default AWS.S3 url generation behaviour, ctx.req.baseUrl + ctx.path is.
      ctx.path = `/${(ctx.mountPath || ctx.req.baseUrl || "")}${ctx.path}`;
    }

    return next();
  };
