
const extend = require('xtend/mutable')
const typeforce = require('typeforce')
const actions = require('./actions')
exports.newApplication = function (product, permalink) {
  return {
    type: actions.NEW_APPLICATION,
    // e.g. 'tradle.CurrentAccount'
    product,
    permalink
  }
}

exports.receivedForm = function (form, application) {
  return {
    type: actions.RECEIVED_FORM,
    form,
    application
  }
}

exports.receivedVerification = function (verification, application) {
  return {
    type: actions.RECEIVED_VERIFICATION,
    verification,
    application
  }
}

exports.createVerification = function (verifiedItem, identityInfo, application) {
  return {
    type: actions.CREATE_VERIFICATION,
    verifiedItem,
    identityInfo,
    application
  }
}

exports.sentVerification = function (verifiedItem, rawVerification, sentVerification) {
  return {
    type: actions.SENT_VERIFICATION,
    verifiedItem,
    rawVerification,
    sentVerification
  }
}

exports.importSession = function (session, models) {
  return {
    type: actions.IMPORT_SESSION,
    session,
    models
  }
}

exports.newCustomer = function (customer) {
  return {
    type: actions.NEW_CUSTOMER,
    customer
  }
}

exports.setProfile = function (profile) {
  return {
    type: actions.SET_PROFILE,
    profile
  }
}

exports.approveProduct = function (application) {
  return {
    type: actions.APPROVE_PRODUCT,
    application
  }
}

exports.approvedProduct = function (application, productType, permalink) {
  return {
    type: actions.APPROVED_PRODUCT,
    productType,
    application,
    permalink
  }
}

exports.revokeProduct = function (productPermalink) {
  return {
    type: actions.REVOKE_PRODUCT,
    product: productPermalink
  }
}

exports.skipForm = function (models, form) {
  return {
    type: actions.SKIP_FORM,
    models,
    form
  }
}

exports.assignRelationshipManager = function (employee) {
  return {
    type: actions.ASSIGN_RELATIONSHIP_MANAGER,
    employee
  }
}

exports.shareContext = function (context, observers) {
  return {
    type: actions.SHARE_CONTEXT,
    context,
    observers
  }
}

exports.unshareContext = function (context, observers) {
  return {
    type: actions.UNSHARE_CONTEXT,
    context,
    observers
  }
}
