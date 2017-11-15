module.exports = require('@tradle/merge-models')()
  .add(require('@tradle/models').models, { validate: false })
  .add(require('@tradle/custom-models'), { validate: false })
  .get()
