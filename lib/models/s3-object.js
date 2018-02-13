"use strict";
const S3Object = function(s3Item) {
  const item = {
    key: s3Item.key,
    contentType: s3Item.contentType,
    contentEncoding: s3Item.contentEncoding,
    contentDisposition: s3Item.contentDisposition,
    md5: s3Item.md5,
    size: s3Item.size,
    modifiedDate: s3Item.modifiedDate,
    creationDate: s3Item.creationDate,
    customMetaData: s3Item.customMetaData
  };
  return item;
};
module.exports = S3Object;
