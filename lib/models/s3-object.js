var S3Object = function (s3Item) {
  var item = {
    key: s3Item.key,
    contentType: s3Item.contentType,
    md5: s3Item.md5,
    size: s3Item.size,
    modifiedData: s3Item.modifiedData,
    creationDate: s3Item.creationDate
  };
  if (customMetaData) {
    item.customMetadata = s3Item.customMetadata;
  }
  return item;
};
module.exports = S3Object;