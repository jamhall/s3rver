"use strict";

const { escapeRegExp, includes } = require("lodash");
const xml2js = require("xml2js");

const templateBuilder = require("./xml-template-builder");

function createWildcardRegExp(str, flags = "") {
  const parts = str.split("*");
  if (parts.length > 2)
    throw new Error(`"${str}" can not have more than one wildcard.`);
  return new RegExp(`^${parts.map(escapeRegExp).join(".*")}$`, flags);
}

// See https://docs.aws.amazon.com/AmazonS3/latest/dev/cors.html
module.exports = function cors(config) {
  // parse and validate config
  let CORSConfiguration;
  if (config) {
    xml2js.parseString(config, { async: false }, (err, parsed) => {
      if (!err) ({ CORSConfiguration } = parsed);
    });
    if (!CORSConfiguration || !CORSConfiguration.CORSRule) {
      throw new Error(
        "The CORS configuration XML you provided was not well-formed or did not validate"
      );
    }
    for (const rule of CORSConfiguration.CORSRule) {
      if (!rule.AllowedOrigin || !rule.AllowedMethod) {
        throw new Error(
          "CORSRule must have at least one AllowedOrigin and AllowedMethod"
        );
      }

      // Keep track if the rule has the plain wildcard '*' origin since S3 responds with '*'
      // instead of echoing back the request origin in this case
      rule.hasWildcardOrigin = rule.AllowedOrigin.includes("*");
      rule.AllowedOrigin = rule.AllowedOrigin.map(o => createWildcardRegExp(o));
      rule.AllowedHeader = (rule.AllowedHeader || []).map(h =>
        createWildcardRegExp(h, "i")
      );
    }
  }

  return function(req, res, next) {
    // Prefer the Access-Control-Request-Method header if supplied
    const method = req.get("access-control-request-method") || req.method;
    const matchedRule = CORSConfiguration
      ? CORSConfiguration.CORSRule.find(rule => {
          return (
            rule.AllowedOrigin.some(pattern =>
              pattern.test(req.get("origin"))
            ) && includes(rule.AllowedMethod, method)
          );
        })
      : null;

    if (req.method === "OPTIONS") {
      let template;

      if (!req.get("origin")) {
        template = templateBuilder.buildError(
          "BadRequest",
          "Insufficient information. Origin request header needed."
        );
        res.header("Content-Type", "application/xml");
        return res.status(403).send(template);
      }

      if (!req.get("access-control-request-method")) {
        template = templateBuilder.buildError(
          "BadRequest",
          "Invalid Access-Control-Request-Method: null"
        );
        res.header("Content-Type", "application/xml");
        return res.status(403).send(template);
      }

      // S3 only checks if CORS is enabled *after* checking the existence of access control headers
      if (!CORSConfiguration) {
        template = templateBuilder.buildError(
          "CORSResponse",
          "CORS is not enabled for this bucket."
        );
        res.header("Content-Type", "application/xml");
        return res.status(403).send(template);
      }

      const requestHeaders = (
        req.get("access-control-request-headers") || ""
      ).split(",");
      const allowedHeaders = matchedRule
        ? requestHeaders
            .map(header => header.trim().toLowerCase())
            .filter(header =>
              matchedRule.AllowedHeader.some(pattern => pattern.test(header))
            )
        : [];

      if (!matchedRule || allowedHeaders.length < requestHeaders.length) {
        template = templateBuilder.buildError(
          "CORSResponse",
          "This CORS request is not allowed. " +
            "This is usually because the evalution of Origin, " +
            "request method / Access-Control-Request-Method or Access-Control-Request-Headers " +
            "are not whitelisted by the resource's CORS spec."
        );
        res.header("Content-Type", "application/xml");
        return res.status(403).send(template);
      }

      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Methods",
        matchedRule.AllowedMethod.join(", ")
      );
      if (req.get("access-control-request-headers")) {
        res.header("Access-Control-Allow-Headers", allowedHeaders.join(", "));
      }

      res.header(
        "Vary",
        "Origin, Access-Control-Request-Headers, Access-Control-Request-Method"
      );

      return res.status(200).send();
    } else if (CORSConfiguration && req.get("origin")) {
      if (matchedRule) {
        res.header(
          "Access-Control-Allow-Origin",
          matchedRule.hasWildcardOrigin ? "*" : req.get("origin")
        );
        if (matchedRule.ExposeHeader) {
          res.header(
            "Access-Control-Expose-Headers",
            matchedRule.ExposeHeader.join(", ")
          );
        }
        if (matchedRule.MaxAgeSeconds) {
          res.header("Access-Control-Max-Age", matchedRule.MaxAgeSeconds[0]);
        }
        res.header("Access-Control-Allow-Credentials", true);
        res.header(
          "Vary",
          "Origin, Access-Control-Request-Headers, Access-Control-Request-Method"
        );
      }
    }
    next();
  };
};
