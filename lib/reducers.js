'use strict'

// TODO: use the immutable library

const extend = require('xtend/mutable')
const clone = require('xtend')
const uniq = require('uniq')
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
  // case actions.UPDATE_CUSTOMER:
  //   return reducers.updateCustomer(action.customer)
  case actions.SET_PROFILE:
    return reducers.setProfile(state, action.profile)
  case actions.CREATE_VERIFICATION:
    var application = utils.getApplication(state, action.application)
    var identity = action.identity
    var verifiedItem = action.verifiedItem
    var form = utils.findFormState(application.forms, verifiedItem.link)
    var verification = newVerificationFor(state, verifiedItem, identity)
    var pendingApplications = updateWithVerification(state.pendingApplications, application, form, { object: verification })
    return clone(state, { pendingApplications })

  case actions.APPROVE_PRODUCT:
    var application = utils.getApplication(state, action.application)
    var productType = application.type
    var products = state.products[productType] || []
    var updatedProducts = products.concat(application)
    var pendingApps = state.pendingApplications
    return clone(state, {
      products: clone(state.products, {
        [productType]: updatedProducts
      }),
      pendingApplications: state.pendingApplications.filter(app => app !== application)
    })

  case actions.APPROVED_PRODUCT:
    var products = state.products[action.productType] || []
    var product = utils.getApplication(products, action.application)
    var productType = product.type
    var updatedProduct = clone(product, { product: action.permalink })
    var updatedProducts = utils.replace(products, product, updatedProduct)
    return clone(state, {
      products: clone(state.products, {
        [productType]: updatedProducts
      })
    })
  case actions.NEW_APPLICATION:
  case actions.RECEIVED_FORM:
  case actions.APPROVE_PRODUCT:
  case actions.REVOKE_PRODUCT:
  case actions.SKIP_FORM:
    return clone(state, {
      pendingApplications: reducers.pendingApplications(state.pendingApplications, action)
    })
  case actions.RECEIVED_VERIFICATION:
    if (utils.getApplication(state.pendingApplications, action.application)) {
      return clone(state, {
        pendingApplications: reducers.pendingApplications(state.pendingApplications, action)
      })
    } else if (utils.getProduct(state, action.application)) {
      return clone(state, {
        products: reducers.products(state.products, action)
      })
    } else {
      break
    }

    // return clone(state, {
    //   forms: reducers.forms(state.forms, action)
    // })
    // return reducers.verifications(state, action)
  case actions.SENT_VERIFICATION:
    return reducers.verifications(state, action)
    // return clone(state, reducers.verifications(state, action), {
    //   prefilled: reducers.prefilled(state.prefilled, action)
    // })
  case actions.IMPORT_SESSION:
    return reducers.importSession(state, action)
  case actions.ASSIGN_RELATIONSHIP_MANAGER:
    return clone(state, {
      relationshipManager: action.employee[ROOT_HASH]
    })
  case actions.SHARE_CONTEXT:
    return clone(state, {
      contexts: reducers.contexts(state.contexts, action)
    })
  }

  return state
}

const reducers = {
  newCustomerState,
  updateCustomer,
  setProfile,
  newApplicationState,
  pendingApplications,
  // forms,
  verifications,
  // prefilled,
  importSession,
  products,
  // skipForm,
  contexts
}

exports.reducers = reducers

function newCustomerState (customer) {
  return extend({
    pendingApplications: [],
    products: {},
    // forms: [],
    prefilled: {},
    bankVersion: BANK_VERSION,
    contexts: {}
  }, tradleUtils.pick(customer, 'permalink', 'profile', 'identity'))
}

function updateCustomer (current, update) {
  return clone(current, tradleUtils.pick(update, 'permalink', 'profile', 'identity'))
}

function setProfile (state, profile) {
  return clone(state, { profile })
}

function newApplicationState (type, permalink) {
  return {
    type,
    permalink,
    skip: [],
    forms: []
    // ,
    // verifications: []
  }
}

function pendingApplications (state, action) {
  switch (action.type) {
  case actions.NEW_APPLICATION:
    var product = action.product
    var existing = utils.find(state, app => app.type === product)
    if (existing) return state

    return state.concat(newApplicationState(product, action.permalink))
  case actions.RECEIVED_FORM:
    var message = action.message
    var formWrapper = action.form
    var application = utils.getApplication(state, action.application)
    if (!application) {
      // TODO: save in prefilled
      return state
    }

    var link = formWrapper.link
    var permalink = formWrapper.permalink
    var form = formWrapper.object
    var existing = utils.findFormState(application.forms, { permalink })
    var replace
    if (existing) {
      if (existing.link === formWrapper.link) {
        return state
      } else {
        replace = true
      }
    }

    var newFormObj = {
      type: form[TYPE],
      form: {
        link: link,
        permalink: permalink,
        // body: req.data, // raw buffer
        body: form,
        txId: action.txId,
        time: form.time
      },
      verifications: []
    }

    var old = replace
      ? application.forms.filter(a => a !== existing)
      : application.forms

    var update = clone(application, {
      forms: [
        ...old,
        newFormObj
      ]
    })

    return utils.replace(state, application, update)

  case actions.RECEIVED_VERIFICATION:
    var application = utils.getApplication(state, action.application)
    var verification = action.verification
    var { type, link } = utils.parseObjectId(verification.object.document.id)
    var form = utils.findFormState(application.forms, link)
    var existing = form.verifications && find(form.verifications, v => v.link === verification.link)
    if (existing) return state

    return updateWithVerification(state, application, form, verification)

  // case actions.APPROVED_PRODUCT:
  case actions.REVOKE_PRODUCT:
    var product = action.product
    var existing = state.products
    var match
    for (var productType in existing) {
      var arr = existing[productType]
      if (!arr) continue

      match = find(arr, application => application.product === product)
      if (!match) continue

      var updatedProducts = arr.map(product => {
        return product === match ? clone(product, { revoked: true }) : product
      })

      return clone(state, {
        products: clone(state.products, {
          [productType]: updatedProducts
        })
      })
    }

    return state

  case actions.SKIP_FORM:
    var models = action.models
    var formToSkip = action.form
    var application = find(state, application => {
      var model = models[application.type]
      var forms = utils.getForms(model)
      return forms.indexOf(formToSkip) !== -1
    })

    if (!application || application.skip.indexOf(formToSkip) !== -1) return state

    return utils.replace(state, application, clone(application, {
      skip: application.skip.concat(formToSkip)
    }))
  }

  return state
}

function products (state, action) {
  switch (action.type) {
  case actions.RECEIVED_VERIFICATION:
    var application = utils.getProduct(state, action.application)
    var verification = action.verification
    var { type, link } = utils.parseObjectId(verification.object.document.id)
    var form = utils.findFormState(application.forms, link)
    var existing = form.verifications && find(form.verifications, v => v.link === verification.link)
    if (existing) return state

    return updateWithVerification(state[application.type], application, form, verification)
  }

  return state
}

function verifications (state, action) {
  switch (action.type) {
  case actions.SENT_VERIFICATION:
    // mutation! bad
    var body = action.sentVerification.object
    extend(action.rawVerification.body, body)
    action.rawVerification.link = action.sentVerification.link
    return state
  }
}

// function prefilled (state, action) {
//   switch (action.type) {
//   case actions.SENT_VERIFICATION:
//     return state
//     // return utils.omit(state, action.verifiedItem[TYPE])
//   }
// }

function importSession (state, action) {
  if (action.type !== actions.IMPORT_SESSION) return state

  const session = action.session
  const models = action.models
  const prefilledForms = clone(state.prefilled || {})
  const hasUnknownType = find(session, data => {
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

function contexts (state, action) {
  if (action.type !== actions.SHARE_CONTEXT && action.type !== actions.UNSHARE_CONTEXT) {
    return state
  }

  const observers = action.observers
  const contextLink = action.context
  const context = state[contextLink] ? clone(state[contextLink]) : { observers: [] }
  if (action.type === actions.SHARE_CONTEXT) {
    context.observers = uniq(context.observers.concat(observers))
  } else {
    // unshare
    context.observers = context.observers.filter(item => {
      return observers.indexOf(item) === -1
    })
  }

  return clone(state, { [contextLink]: context })
}

function updateWithVerification (applications, application, form, verification) {
  var verifications = [
    ...form.verifications,
    {
      link: verification.link,
      txId: verification.txId,
      body: verification.object
    }
  ]

  var updatedForm = clone(form, {
    verifications: verifications
  })

  var updatedApp = clone(application, {
    forms: utils.replace(application.forms, form, updatedForm)
  })

  return utils.replace(applications, application, updatedApp)
}
