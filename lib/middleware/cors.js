"use strict";

const { escapeRegExp } = require("lodash");
const xmlParser = require("fast-xml-parser");

// https://docs.aws.amazon.com/AmazonS3/latest/dev/cors.html#cors-allowed-methods
const corsAllowedMethods = ["GET", "PUT", "POST", "DELETE", "HEAD"];

function createWildcardRegExp(str, flags = "") {
  const parts = str.split("*");
  if (parts.length > 2)
    throw new Error(`"${str}" can not have more than one wildcard.`);
  return new RegExp(`^${parts.map(escapeRegExp).join(".*")}$`, flags);
}

// See https://docs.aws.amazon.com/AmazonS3/latest/dev/cors.html
module.exports = config => {
  // parse and validate config
  let CORSConfiguration;
  if (config) {
    const configString = config.toString();
    if (xmlParser.validate(configString) !== true) {
      throw new Error(
        "The CORS configuration XML you provided was not well-formed or did not validate"
      );
    }
    ({ CORSConfiguration } = xmlParser.parse(configString));
    if (!CORSConfiguration || !CORSConfiguration.CORSRule) {
      throw new Error(
        "The CORS configuration XML you provided was not well-formed or did not validate"
      );
    }
    CORSConfiguration.CORSRule = [].concat(CORSConfiguration.CORSRule);
    for (const rule of CORSConfiguration.CORSRule) {
      if (!rule.AllowedOrigin || !rule.AllowedMethod) {
        throw new Error(
          "CORSRule must have at least one AllowedOrigin and AllowedMethod"
        );
      }

      rule.AllowedMethod = [].concat(rule.AllowedMethod);
      for (const method of rule.AllowedMethod) {
        if (!corsAllowedMethods.includes(method)) {
          throw new Error(
            "Found unsupported HTTP method in CORS config. Unsupported method is " +
              method
          );
        }
      }

      // Keep track if the rule has the plain wildcard '*' origin since S3 responds with '*'
      // instead of echoing back the request origin in this case
      rule.hasWildcardOrigin = [].concat(rule.AllowedOrigin).includes("*");
      rule.AllowedOrigin = []
        .concat(rule.AllowedOrigin)
        .map(o => createWildcardRegExp(o));
      rule.AllowedHeader = []
        .concat(rule.AllowedHeader || [])
        .map(h => createWildcardRegExp(h, "i"));
    }
  }

  return function cors(ctx, next) {
    // Prefer the Access-Control-Request-Method header if supplied
    const method = ctx.get("access-control-request-method") || ctx.method;
    const origin = ctx.get("origin");
    const matchedRule = CORSConfiguration
      ? CORSConfiguration.CORSRule.find(
          rule =>
            rule.AllowedOrigin.some(pattern => pattern.test(origin)) &&
            rule.AllowedMethod.includes(method.toUpperCase())
        )
      : null;

    if (ctx.method === "OPTIONS") {
      if (!origin) {
        ctx.throw(
          403,
          "Insufficient information. Origin request header needed.",
          { code: "BadRequest" }
        );
      }

      if (!ctx.get("access-control-request-method")) {
        ctx.throw(403, "Invalid Access-Control-Request-Method: null", {
          code: "BadRequest"
        });
      }

      // S3 only checks if CORS is enabled *after* checking the existence of access control headers
      if (!CORSConfiguration) {
        ctx.throw(403, "CORS is not enabled for this bucket.", {
          code: "CORSResponse"
        });
      }

      const requestHeaders = ctx.get("access-control-request-headers")
        ? ctx.get("access-control-request-headers").split(",")
        : [];

      const allowedHeaders = matchedRule
        ? requestHeaders
            .map(header => header.trim().toLowerCase())
            .filter(header =>
              matchedRule.AllowedHeader.some(pattern => pattern.test(header))
            )
        : [];

      if (!matchedRule || allowedHeaders.length < requestHeaders.length) {
        ctx.throw(
          403,
          "This CORS request is not allowed. " +
            "This is usually because the evalution of Origin, " +
            "request method / Access-Control-Request-Method or Access-Control-Request-Headers " +
            "are not whitelisted by the resource's CORS spec.",
          { code: "CORSResponse" }
        );
      }

      ctx.set("Access-Control-Allow-Origin", "*");
      ctx.set(
        "Access-Control-Allow-Methods",
        matchedRule.AllowedMethod.join(", ")
      );
      if (ctx.get("access-control-request-headers")) {
        ctx.set("Access-Control-Allow-Headers", allowedHeaders.join(", "));
      }

      ctx.set(
        "Vary",
        "Origin, Access-Control-Request-Headers, Access-Control-Request-Method"
      );

      ctx.status = 200;
    } else if (CORSConfiguration && origin) {
      if (matchedRule) {
        ctx.set(
          "Access-Control-Allow-Origin",
          matchedRule.hasWildcardOrigin ? "*" : origin
        );
        if (matchedRule.ExposeHeader) {
          ctx.set(
            "Access-Control-Expose-Headers",
            matchedRule.ExposeHeader.join(", ")
          );
        }
        if (matchedRule.MaxAgeSeconds) {
          ctx.set("Access-Control-Max-Age", matchedRule.MaxAgeSeconds[0]);
        }
        ctx.set("Access-Control-Allow-Credentials", true);
        ctx.set(
          "Vary",
          "Origin, Access-Control-Request-Headers, Access-Control-Request-Method"
        );
      }
    }
    return next();
  };
};
