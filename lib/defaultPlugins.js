
const constants = require('@tradle/engine').constants
const TYPE = constants.TYPE
const utils = require('./utils')

module.exports = {
  shouldSendVerification: function ({ form }) {
    if (!this._auto.verify) return false

    const iVerified = form.verifications.some(v => {
      return v.author.permalink === this.node.permalink
    })

    if (iVerified) return false
  },
  onApplicationFormsCollected: function ({ req, state, application }) {
    return this.send({
      req: req,
      msg: {
        [TYPE]: 'tradle.ApplicationSubmitted',
        application: req.context,
        message: 'Application submitted. We\'ll be in touch shortly!',
        forms: utils.getFormIds(application.forms)
      }
    })
  },
  shouldIssueProduct: function ({ state, application }) {
    if (!this._auto.verify) return false

    // const req = opts.req
    // let state = req.state
    // let appLink = opts.application
    // let application = utils.getApplication(req.state, appLink)
    const productType = application.type
    const existing = (state.products[productType] || []).filter(product => {
      return !product.revoked
    })

    const productModel = this.models[productType]
    if (existing.length && !productModel.customerCanHaveMultiple) {
      throw new Error('customer already has this product')
    }

    const missingForms = utils.getMissingForms(application, productModel)
    if (missingForms.length) {
      throw new Error('request the following forms first: ' + missingForms.join(', '))
    }

    const missingVerifications = utils.getUnverifiedForms(this.node.identity, application, productModel)
    if (missingVerifications.length) {
      const types = missingVerifications.map(f => f.type).join(', ')
      throw new Error('verify the following forms first: ' + types)
    }

    return true
  },
  willRequestEdit: function ({ req, state, editRequest }) {
    // amend editRequest
    // e.g. editRequest.binary = true
  },
  willRequestForm: function ({ state, application, form, formRequest }) {
  }
}
