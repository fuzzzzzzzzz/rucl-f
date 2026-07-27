const cloud = require('wx-server-sdk')
const { createDeletionWorker } = require('./handler')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = createDeletionWorker({
  cloud,
  database: cloud.database(),
})
