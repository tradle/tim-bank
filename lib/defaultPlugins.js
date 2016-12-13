
const Q = require('bluebird-q')
const co = Q.async
const constants = require('@tradle/engine').constants
const TYPE = constants.TYPE
const types = require('./types')
const IDENTITY_PUBLISH_REQUEST = types.IDENTITY_PUBLISH_REQUEST
const SELF_INTRODUCTION = types.SELF_INTRODUCTION
const utils = require('./utils')

module.exports = {
  willReceive: co(function* (msg, senderInfo) {
    const obj = msg.object
    const type = obj[TYPE]
    this._debug('receiving ' + type)

    const from = senderInfo.permalink || senderInfo.fingerprint || senderInfo.pubKey
    if (type === SELF_INTRODUCTION || type === IDENTITY_PUBLISH_REQUEST) {
      const unlock = yield this.lock(from)
      try {
        yield this.tim.addContactIdentity(obj.identity)
      } catch (err) {
        this._debug('failed to add customer identity to address book', err)
        throw err
      } finally {
        unlock()
      }
    }
  }),
  didReceive: function ({ req, msg }) {
  },
  willSend: function ({ req, msg }) {
  },
  didSend: function ({ req, msg }) {
  },
  shouldSendVerification: function ({ form }) {
    if (!this._auto.verify) {
      // make an exception if my employee already verified
      return !form.issuedVerifications.length && form.verifications.some(isMine)
    }

    const iVerified = (form.issuedVerifications || []).some(isMine)
    if (iVerified) return false

    function isMine (verification) {
      return verification.author.permalink === this.node.permalink
    }
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
