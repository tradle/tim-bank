'use strict'

const test = require('tape')
const constants = require('@tradle/engine').constants
const CUR_HASH = constants.LINK
const ROOT_HASH = constants.PERMALINK
const TYPE = constants.TYPE
const types = constants.TYPES
const utils = require('../lib/utils')
const getNewState = require('../lib/reducers')
const Actions = require('../lib/actionCreators')
const multiEntryProduct =  require('./fixtures/multi-entry')

test('state changes', function (t) {
  const customerRootHash = 'blah'
  let state = getNewState(null, Actions.newCustomer({ permalink: customerRootHash }))
  t.same(state, {
    pendingApplications: [],
    products: {},
    forms: [],
    prefilled: {},
    bankVersion: require('../package').version,
    [ROOT_HASH]: customerRootHash
  })

  state = getNewState(state, Actions.newApplication(multiEntryProduct.id))
  t.same(state.pendingApplications, [ {type: multiEntryProduct.id, skip: []} ])

  let formMsg = {
    [TYPE]: 'some form',
    [CUR_HASH]: 'ooga',
    parsed: {
      data: {
        [TYPE]: 'some form'
      }
    }
  }

  state = getNewState(state, Actions.receivedForm(formMsg))
  const expectedForms = [{
    type: 'some form',
    form: {
      [CUR_HASH]: formMsg[CUR_HASH],
      body: formMsg.parsed.data,
      txId: undefined
    },
    verifications: []
  }]

  t.same(state.forms, expectedForms)

  // receiving same form again shouldn't change anything
  state = getNewState(state, Actions.receivedForm(formMsg))
  t.same(state.forms, expectedForms)

  let verificationMsg = {
    [CUR_HASH]: 'asdf',
    parsed: {
      data: {
        [TYPE]: types.VERIFICATION,
        document: {
          id: 'tradle.Form_' + formMsg[CUR_HASH]
        }
      }
    }
  }

  state = getNewState(state, Actions.receivedVerification(verificationMsg))
  expectedForms[0].verifications.push({
    [CUR_HASH]: verificationMsg[CUR_HASH],
    body: verificationMsg.parsed.data,
    txId: undefined
  })

  t.same(state.forms, expectedForms)

  // receiving same verification again shouldn't change anything
  state = getNewState(state, Actions.receivedVerification(verificationMsg))
  t.same(state.forms, expectedForms)

  const models = utils.processModels([
    multiEntryProduct
  ])

  state = getNewState(state, Actions.skipForm(models, 'tradle.AboutYou'))
  t.same(state.pendingApplications, [ { type: multiEntryProduct.id, skip: ['tradle.AboutYou'] }])

  // skip again shouldn't change anything
  state = getNewState(state, Actions.skipForm(models, 'tradle.AboutYou'))
  t.same(state.pendingApplications, [ { type: multiEntryProduct.id, skip: ['tradle.AboutYou'] }])

  t.end()
})
