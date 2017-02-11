
const Q = require('bluebird-q')
const co = Q.async
const constants = require('@tradle/engine').constants
const TYPE = constants.TYPE
const {
  IDENTITY_PUBLISH_REQUEST,
  SELF_INTRODUCTION,
  EMPLOYEE_ONBOARDING
} = require('./types')

const utils = require('./utils')

module.exports = {
  newCustomer: function ({ req }) {
  },
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
    const isMine = verification => {
      const author = typeof verification.author === 'object'
        ? verification.author.permalink
        : verification.author

      return author === this.tim.permalink
    }

    if (!this._auto.verify) {
      // make an exception if my employee already verified
      return !form.issuedVerifications.length && form.verifications.some(isMine)
    }

    const iVerified = (form.issuedVerifications || []).some(isMine)
    if (iVerified) return false
  },
  onApplicationFormsCollected: co(function* ({ req, application }) {
    const { state } = req
    const productType = application.type
    let should
    if (productType === EMPLOYEE_ONBOARDING) {
      should = { result: false }
    } else {
      should = yield this.shouldIssueProduct({ state, application })
    }

    if (should.result) {
      return this._approveProduct({ req, application })
    }

    return this.send({
      req: req,
      msg: {
        [TYPE]: 'tradle.ApplicationSubmitted',
        application: {
          title: '',
          id: utils.resourceId({
            type: 'tradle.ProductApplication',
            permalink: req.context
          })
        },
        message: 'Application submitted. We\'ll be in touch shortly!',
        forms: utils.getFormIds(application.forms).map(id => {
          return { id }
        })
      }
    })
  }),
  shouldIssueProduct: co(function* ({ state, application }) {
    const self = this
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

    let missingVerifications = utils.getUnverifiedForms(this.node.identity, application, this.models)
    const canVerify = yield Q.all(missingVerifications.map(co(function *(form) {
      const { result } = yield self.canVerify({ state, application, form })
      return result
    })))

    missingVerifications = missingVerifications.filter((form, i) => canVerify[i])
    if (missingVerifications.length) {
      const types = missingVerifications.map(f => f.type).join(', ')
      throw new Error('verify the following forms first: ' + types)
    }

    return true
  }),
  willRequestEdit: function ({ req, state, editRequest }) {
    // amend editRequest
    // e.g. editRequest.binary = true
  },
  willRequestForm: function ({ state, application, form, formRequest }) {
  },
  /**
   * return false if this a form that this provider doesn't verify
   */
  canVerify: function ({ form }) {
  }
}
