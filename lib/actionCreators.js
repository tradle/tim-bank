
const extend = require('xtend/mutable')
const typeforce = require('typeforce')
const actions = require('./actions')
exports.newApplication = function (product) {
  return {
    type: actions.NEW_APPLICATION,
    product
  }
}

exports.receivedForm = function (req) {
  return {
    type: actions.RECEIVED_FORM,
    req
  }
}

exports.receivedVerification = function (msg) {
  return {
    type: actions.RECEIVED_VERIFICATION,
    msg
  }
}

exports.createVerification = function (verifiedItem, identity) {
  return {
    type: actions.CREATE_VERIFICATION,
    verifiedItem,
    identity
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

exports.newCustomer = function (customerRootHash) {
  return {
    type: actions.NEW_CUSTOMER,
    customerRootHash
  }
}

exports.approveProduct = function (product) {
  return {
    type: actions.APPROVE_PRODUCT,
    product
  }
}

exports.approvedProduct = function (product) {
  return {
    type: actions.APPROVE_PRODUCT,
    product
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
