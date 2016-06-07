'use strict'

const test = require('tape')
const constants = require('@tradle/constants')
const CUR_HASH = constants.CUR_HASH
const ROOT_HASH = constants.ROOT_HASH
const TYPE = constants.TYPE
const types = constants.TYPES
const getNewState = require('../lib/reducers')
const Actions = require('../lib/actionCreators')

test('state changes', function (t) {
  const customerRootHash = 'blah'
  let state = getNewState(null, Actions.newCustomer(customerRootHash))
  t.same(state, {
    pendingApplications: [],
    products: {},
    forms: [],
    prefilled: {},
    bankVersion: require('../package').version,
    [ROOT_HASH]: customerRootHash
  })

  state = getNewState(state, Actions.newApplication('something'))
  t.same(state.pendingApplications, [ {type: 'something'} ])

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

  t.end()
})
