"use strict";

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
    } else if (ctx.hostname !== "localhost" && ctx.hostname !== "127.0.0.1") {
      // otherwise attempt to distinguish virtual host-style requests
      ctx.path = `/${bucket}${ctx.path}`;
    }

    return next();
  };
