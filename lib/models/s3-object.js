"use strict";

const { pick } = require("lodash");

class S3Object {
  constructor(s3Item) {
    Object.assign(
      this,
      pick(s3Item, [
        "key",
        "contentType",
        "contentEncoding",
        "contentDisposition",
        "md5",
        "size",
        "modifiedDate",
        "creationDate",
        "customMetaData"
      ])
    );
  }
}
module.exports = S3Object;
