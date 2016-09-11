'use strict'

const extend = require('xtend/mutable')
const clone = require('xtend')
const tradle = require('@tradle/engine')
const constants = tradle.constants
const tradleUtils = tradle.utils
const TYPE = constants.TYPE
const CUR_HASH = constants.CUR_HASH
const ROOT_HASH = constants.ROOT_HASH
const BANK_VERSION = require('../package.json').version
const types = require('./types')
const actions = require('./actions')
const utils = require('./utils')
const find = utils.find

module.exports = exports = function reducer (state, action) {
  switch (action.type) {
  case actions.NEW_CUSTOMER:
    return reducers.newCustomerState(action.customer)
  case actions.UPDATE_CUSTOMER:
    return reducers.updateCustomer(action.customer)
  case actions.NEW_APPLICATION:
    return clone(state, {
      pendingApplications: reducers.pendingApplications(state.pendingApplications, action)
    })
  case actions.RECEIVED_FORM:
    return clone(state, {
      forms: reducers.forms(state.forms, action)
    })
  case actions.RECEIVED_VERIFICATION:
  case actions.CREATE_VERIFICATION:
    return reducers.verifications(state, action)
  case actions.SENT_VERIFICATION:
    return clone(state, reducers.verifications(state, action), {
      prefilled: reducers.prefilled(state.prefilled, action)
    })
  case actions.IMPORT_SESSION:
    return reducers.importSession(state, action)
  case actions.APPROVE_PRODUCT:
  case actions.APPROVED_PRODUCT:
  case actions.REVOKE_PRODUCT:
    return reducers.products(state, action)
  case actions.SKIP_FORM:
    return clone(state, {
      pendingApplications: reducers.skipForm(state.pendingApplications, action)
    })
  case actions.ASSIGN_RELATIONSHIP_MANAGER:
    return clone(state, {
      relationshipManager: action.employee[ROOT_HASH]
    })
  }

  return state
}

const reducers = {
  newCustomerState,
  updateCustomer,
  newApplicationState,
  pendingApplications,
  forms,
  verifications,
  prefilled,
  importSession,
  products,
  skipForm
}

exports.reducers = reducers

function newCustomerState (customer) {
  return extend({
    pendingApplications: [],
    products: {},
    forms: [],
    prefilled: {},
    bankVersion: BANK_VERSION
  }, tradleUtils.pick(customer, 'permalink', 'profile', 'identity'))
}

function updateCustomer (current, update) {
  return clone(current, tradleUtils.pick(update, 'permalink', 'profile', 'identity'))
}

function newApplicationState (type) {
  return {
    type,
    skip: []
  }
}

function pendingApplications (state, action) {
  switch (action.type) {
  case actions.NEW_APPLICATION:
    const product = action.product
    if (utils.findApplication(state, product)) return state

    return state.concat(newApplicationState(product))
  }

  return state
}

function forms (state, action) {
  switch (action.type) {
  case actions.RECEIVED_FORM:
    const req = action.req
    const link = req.payload.link
    const existing = utils.findFormState(state, link)
    if (existing) return state

    return state.concat({
      type: req[TYPE],
      form: {
        link: link,
        // body: req.data, // raw buffer
        body: req.payload.object,
        txId: action.txId
      },
      verifications: []
    })
  }
}

function verifications (state, action) {
  switch (action.type) {
  case actions.CREATE_VERIFICATION:
    var identity = action.identity
    var verifiedItem = action.verifiedItem
    var form = utils.findFormState(state.forms, verifiedItem.link)
    var verification = newVerificationFor(state, verifiedItem, identity)
    // mutation! bad
    form.verifications = form.verifications.concat({
      txId: null,
      body: verification
    })

    return state
  case actions.RECEIVED_VERIFICATION:
    var verification = action.verification
    var parts = verification.object.document.id.split('_')
    var type = parts[0]
    var hash = parts[1]

    var form = utils.findFormState(state.forms, hash)
    var existing = form.verifications && utils.find(form.verifications, v => v.link === verification.link)
    if (existing) return state

    // mutation! bad
    form.verifications = (form.verifications || []).concat({
      link: verification.link,
      txId: verification.txId,
      body: verification.object
    })

    return state
  case actions.SENT_VERIFICATION:
    // mutation! bad
    const body = action.sentVerification.object
    extend(action.rawVerification.body, body)
    action.rawVerification.link = action.sentVerification.link
    return state
  }
}

function prefilled (state, action) {
  switch (action.type) {
  case actions.SENT_VERIFICATION:
    return state
    // return utils.omit(state, action.verifiedItem[TYPE])
  }
}

function importSession (state, action) {
  if (action.type !== actions.IMPORT_SESSION) return state

  const session = action.session
  const models = action.models
  const prefilledForms = clone(state.prefilled || {})
  const hasUnknownType = utils.find(session, data => {
    return !models[data[TYPE]]
  })

  if (hasUnknownType) {
    throw new Error(`unknown type ${hasUnknownType[TYPE]}`)
  }

  const forms = session.filter(data => {
    return models[data[TYPE]].subClassOf === 'tradle.Form'
  })

  // products = session.filter(data => {
  //   return this._models[data[TYPE]].subClassOf === 'tradle.MyProduct'
  // })

  // products.forEach(product => {
  //   const pType = product[TYPE]
  //   if (!state.importedProducts) state.importedProducts = {}
  //   if (!state.importedProducts[pType]) state.importedProducts[pType] = []

  //   state.importedProducts[pType].push(product)
  // })

  // forms.concat(products).forEach(data => {
  forms.forEach(data => {
    prefilledForms[data[TYPE]] = {
      form: data
    }
  })

  const verifications = session.filter(data => data[TYPE] === types.VERIFICATION)
  verifications.forEach(verification => {
    const type = verification.document[TYPE]
    const prefilled = prefilledForms[type]
    if (prefilled) {
      prefilled.verification = verification
    }
  })

  return clone(state, { prefilled: prefilledForms })
}

function newVerificationFor (state, wrapper, identity) {
  const doc = wrapper.object
  let verification = utils.getImportedVerification(state, doc)
  if (!verification) {
    verification = {}
  } else if (verification.time) {
    verification.backDated = verification.time
    delete verification.time
  }

  verification.document = {
    id: doc[TYPE] + '_' + wrapper.permalink + '_' + wrapper.link,
    title: doc.title || doc[TYPE]
  }

  verification.documentOwner = {
    id: types.IDENTITY + '_' + wrapper.author.permalink,
    title: wrapper.author.permalink
  }

  const org = identity.organization
  if (org) {
    verification.organization = org
  }

  verification[TYPE] = types.VERIFICATION
  return verification
}

function products (state, action) {
  switch (action.type) {
  case actions.APPROVE_PRODUCT:
    var productType = action.product
    var acquiredProduct = {
      type: productType
    }

    var updatedProducts = (state.products[productType] || []).concat(acquiredProduct)
    var pendingApps = state.pendingApplications
    return clone(state, {
      products: clone(state.products, {
        [productType]: updatedProducts
      }),
      pendingApplications: state.pendingApplications.filter(app => app.type !== productType)
    })
  case actions.APPROVED_PRODUCT:
    var productType = action.product.type
    var updatedProducts = state.products[productType].map(product => {
      return product === action.product
        ? clone(product, { permalink: action.permalink })
        : product
    })

    return clone(state, {
      products: clone(state.products, {
        [productType]: updatedProducts
      })
    })
  case actions.REVOKE_PRODUCT:
    var productPermalink = action.product
    var existing = state.products
    var match
    for (var productType in existing) {
      var arr = existing[productType]
      if (!arr) continue

      match = find(arr, product => product.permalink === productPermalink)
      if (!match) continue

      var newProductsArr = arr.map(product => {
        return product === match
          ? clone(product, { revoked: true })
          : product
      })

      return clone(state, {
        products: clone(state.products, {
          [productType]: newProductsArr
        })
      })
    }

    break
  }

  return state
}

function skipForm (state, action) {
  const models = action.models
  const formToSkip = action.form
  const product = utils.find(state, product => {
    const model = models[product.type]
    const forms = utils.getForms(model)
    return forms.indexOf(formToSkip) !== -1
  })

  if (!product || product.skip.indexOf(formToSkip) !== -1) return state

  return utils.replace(state, product, clone(product, {
    skip: product.skip.concat(formToSkip)
  }))
}
