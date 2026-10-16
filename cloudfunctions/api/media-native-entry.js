const cloud = require('wx-server-sdk')
const { mediaAuditConfigFromEnvironment } = require('./media-runtime-config')
const { createNativeMediaCallbackHandler } = require('./media-native-handler')

// Separate deployment handler. Never import the student API or trust event identity.
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
exports.main = createNativeMediaCallbackHandler({
  cloud,
  database: cloud.database(),
  config: mediaAuditConfigFromEnvironment(process.env),
  expectedEnvironmentId: process.env.MEDIA_CALLBACK_ENV_ID,
})
