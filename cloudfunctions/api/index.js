const cloud = require('wx-server-sdk')
const { createApiHandler } = require('./handler')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = createApiHandler({ cloud, database: cloud.database() })
