"use strict";

const Router = require("koa-router");
const { union } = require("lodash");

const bucketCtrl = require("./controllers/bucket");
const objectCtrl = require("./controllers/object");
const serviceCtrl = require("./controllers/service");
const S3Error = require("./models/error");

const router = new Router();

// NOTE: The below is only an approximation of S3's behavior
// For the most part, S3 will complain if you attempt a bucket method on an object, but
// it won't consisently reject actions on buckets that are supported by objects (and vice-versa).
const queryMethod = methods =>
  async function queryMethod(ctx, next) {
    const matchedMethods = methods.filter(method => method in ctx.query);
    if (matchedMethods.length > 1) {
      throw new S3Error(
        "InvalidArgument",
        `Conflicting query string parameters: ${matchedMethods.join(", ")}`,
        {
          ArgumentName: "ResourceType",
          ArgumentValue: matchedMethods[0]
        }
      );
    }
    if (matchedMethods.length === 1) {
      ctx.params.queryMethod = matchedMethods[0];
    }
    await next();
    if (ctx.state.methodIsNotAllowed) {
      throw new S3Error(
        "MethodNotAllowed",
        "The specified method is not allowed against this resource.",
        {
          Method: ctx.method.toUpperCase(),
          ResourceType: ctx.params.queryMethod.toUpperCase()
        }
      );
    }
  };

router.get("/", serviceCtrl.getService);

router
  .use("/:bucket", queryMethod(bucketCtrl.METHODS))
  .delete("/:bucket", bucketCtrl.bucketExists, ctx => {
    switch (ctx.params.queryMethod) {
      case undefined:
        return bucketCtrl.deleteBucket(ctx);
      case "analysis":
      case "cors":
      case "encryption":
      case "lifecycle":
      case "publicAccessBlock":
      case "metrics":
      case "policy":
      case "replication":
      case "tagging":
      case "website":
        ctx.throw(501);
        break;
      default:
        ctx.state.methodIsNotAllowed = true;
    }
  })
  .get("/:bucket", bucketCtrl.bucketExists, ctx => {
    switch (ctx.params.queryMethod) {
      case undefined:
        return bucketCtrl.getBucket(ctx);
      case "acl":
      case "analytics":
      case "cors":
      case "encryption":
      case "inventory":
      case "lifecycle":
      case "location":
      case "logging":
      case "metrics":
      case "notification":
      case "object-lock":
      case "policyStatus":
      case "publicAccessBlock":
      case "replication":
      case "requestPayment":
      case "tagging":
      case "uploads":
      case "versioning":
      case "website":
        ctx.throw(501);
        break;
      default:
        ctx.state.methodIsNotAllowed = true;
    }
  })
  .post("/:bucket", bucketCtrl.bucketExists, ctx => {
    switch (ctx.params.queryMethod) {
      case "delete":
        return objectCtrl.deleteMultipleObjects(ctx);
      default:
        ctx.state.methodIsNotAllowed = true;
    }
  })
  .put("/:bucket", async ctx => {
    if (ctx.params.queryMethod) {
      await bucketCtrl.bucketExists(ctx);
    }
    switch (ctx.params.queryMethod) {
      case undefined:
        return bucketCtrl.putBucket(ctx);
      case "accelerate":
      case "acl":
      case "analytics":
      case "cors":
      case "encryption":
      case "inventory":
      case "lifecycle":
      case "logging":
      case "metrics":
      case "notification":
      case "policy":
      case "publicAccessBlock":
      case "replication":
      case "requestPayment":
      case "tagging":
      case "versioning":
      case "website":
        ctx.throw(501);
        break;
      default:
        ctx.state.methodIsNotAllowed = true;
    }
  });

const objectMethods = union(bucketCtrl.METHODS, objectCtrl.METHODS).sort();
router
  .use("/:bucket/:key+", bucketCtrl.bucketExists, queryMethod(objectMethods))
  .delete("/:bucket/:key+", ctx => {
    switch (ctx.params.queryMethod) {
      case undefined:
        return objectCtrl.deleteObject(ctx);
      case "tagging":
        ctx.throw(501);
        break;
      default:
        ctx.state.methodIsNotAllowed = true;
    }
  })
  .get("/:bucket/:key+", ctx => {
    switch (ctx.params.queryMethod) {
      case undefined:
        return objectCtrl.getObject(ctx);
      case "acl":
        return objectCtrl.getObjectAcl(ctx);
      case "legal-hold":
      case "retention":
      case "tagging":
      case "torrent":
        ctx.throw(501);
        break;
      default:
        ctx.state.methodIsNotAllowed = true;
    }
  })
  .post("/:bucket/:key+", ctx => {
    switch (ctx.params.queryMethod) {
      case "uploadId":
        return objectCtrl.completeMultipartUpload(ctx);
      case "uploads":
        return objectCtrl.initiateMultipartUpload(ctx);
      case undefined:
      case "select":
        ctx.throw(501);
        break;
      default:
        ctx.state.methodIsNotAllowed = true;
    }
  })
  .put("/:bucket/:key+", ctx => {
    switch (ctx.params.queryMethod) {
      case undefined:
        return "x-amz-copy-source" in ctx.headers
          ? objectCtrl.putObjectCopy(ctx)
          : objectCtrl.putObject(ctx);
      case "uploadId":
        return objectCtrl.uploadPart(ctx);
      case "acl":
      case "tagging":
        ctx.throw(501);
        break;
      default:
        ctx.state.methodIsNotAllowed = true;
    }
  });

// append trailing slash to key when applicable
router.param("key", (key, ctx, next) => {
  if (ctx.path.endsWith("/")) {
    ctx.params.key = key + "/";
  }
  return next();
});

module.exports = router;
