"use strict";

const net = require("net");

/**
 * Middleware that rewrites URLs for buckets specified via subdomain or host header
 */
module.exports = forceVirtualHostnames => {
  return function vhost(ctx, next) {
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
      if (forceVirtualHostnames) {
        // otherwise attempt to distinguish virtual host-style requests
        ctx.path = `/${ctx.hostname}${ctx.path}`;
      } else {
        // it's a standard path
        ctx.path = `${ctx.req.baseUrl || ""}${ctx.path}`;
      }
    }
    return next();
  };
};
