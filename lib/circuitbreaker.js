'use strict'
const AWS = require('aws-sdk')
const circuitBreakerTable = process.env.CIRCUITBREAKER_TABLE
const lambdaFunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME
const dynamoDb = new AWS.DynamoDB.DocumentClient()

var CircuitBreaker = (function () {
  function CircuitBreaker (request, options) {
    if (options === undefined) {
      options = {}
    }
    const defaults = {
      failureThreshold: 5,
      successThreshold: 2,
      timeout: 10000,
      fallback: null
    }
    Object.assign(this, defaults, options, {
      request: request,
      state: 'CLOSED',
      failureCount: 0,
      successCount: 0,
      nextAttempt: Date.now()
    })
  }

  var _proto = CircuitBreaker.prototype

  _proto.fire = async function fire () {
    const data = await this.getState()
    const itemData = data.Item
    if (itemData !== undefined) {
      this.state = itemData.circuitState
      this.failureCount = itemData.failureCount
      this.successCount = itemData.successCount
      this.nextAttempt = itemData.nextAttempt
    }
    if (this.state === 'OPEN') {
      if (this.nextAttempt <= Date.now()) {
        this.half()
      } else {
        if (this.fallback) {
          return this.tryFallback()
        }
        throw new Error('CircuitBreaker state: OPEN')
      }
    }
    try {
      const response = await this.request()
      return this.success(response)
    } catch (err) {
      return this.fail(err)
    }
  }

  _proto.success = async function success (response) {
    if (this.state === 'HALF') {
      this.successCount++
      if (this.successCount > this.successThreshold) {
        this.close()
      }
    }
    this.failureCount = 0
    await this.updateState('Success')
    return response
  }

  _proto.fail = async function fail (err) {
    this.failureCount++
    if (this.failureCount >= this.failureThreshold) {
      this.open()
    }
    await this.updateState('Failure')
    if (this.fallback) return this.tryFallback()
    return err
  }

  _proto.open = function open () {
    console.log('CircuitBreaker state: OPEN')
    this.state = 'OPEN'
    this.nextAttempt = Date.now() + this.timeout
  }

  _proto.close = function close () {
    console.log('CircuitBreaker state: CLOSED')
    this.successCount = 0
    this.failureCount = 0
    this.state = 'CLOSED'
  }

  _proto.half = function half () {
    console.log('CircuitBreaker state: HALF')
    this.state = 'HALF'
  }

  _proto.tryFallback = async function tryFallback () {
    console.log('CircuitBreaker Fallback request')
    try {
      const response = await this.fallback()
      return response
    } catch (err) {
      return err
    }
  }

  _proto.getState = async function getState () {
    try {
      const ddbParams = {
        TableName: circuitBreakerTable,
        Key: {
          id: lambdaFunctionName
        }
      }
      const data = await dynamoDb.get(ddbParams).promise()
      return data
    } catch (err) {
      console.error(err)
      throw err
    }
  }

  _proto.updateState = async function updateState (action) {
    try {
      const ddbParams = {
        TableName: circuitBreakerTable,
        Key: {
          id: lambdaFunctionName
        },
        UpdateExpression:
          'set circuitState=:st, failureCount=:fc, successCount=:sc, nextAttempt=:na, stateTimestamp=:ts',
        ExpressionAttributeValues: {
          ':st': this.state,
          ':fc': this.failureCount,
          ':sc': this.successCount,
          ':na': this.nextAttempt,
          ':ts': Date.now()
        },
        ReturnValues: 'UPDATED_NEW'
      }
      const data = await dynamoDb.update(ddbParams).promise()
      return data
    } catch (err) {
      console.log(err)
      return err
    }
  }
  return CircuitBreaker
})()

module.exports = CircuitBreaker
