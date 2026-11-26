// The test run path: a budget command with a test mark takes the estimate-first path.
import { expect, test } from 'claude-code/testing'
import { inlineIn, testInline } from './core.ts'

test('testInline finds a budget command with a test mark', async () => {
  expect(testInline('/budget try 0.05 read the ten files [tb-test:t3]')).toEqual({ limit: 0.05, task: 'read the ten files [tb-test:t3]' })
  expect(testInline('/budget try read the ten files and list them [tb-test:t2]')).toEqual({ task: 'read the ten files and list them [tb-test:t2]' })
  expect(testInline('/budget try $2 read the ten files [tb-test:a]')?.limit).toBe(2)
})

test('testInline leaves a message with no test mark alone', async () => {
  expect(testInline('/budget try 0.05 read the ten files')).toBeNull()
  expect(testInline('/budget 0.05 read the ten files [tb-test:t3]')).toBeNull()
  expect(testInline('/budget try read the ten files and list them')).toBeNull()
  expect(testInline('read the ten files [tb-test:t2]')).toBeNull()
  // The normal path still finds the command.
  expect(inlineIn('/budget 0.05 read the ten files')?.inline.limit).toBe(0.05)
})

test('testInline leaves a forced start and a plan alone', async () => {
  expect(testInline('/budget try 0.05! read the ten files [tb-test:t3]')).toBeNull()
  expect(testInline('/budget try plan 5 read the ten files [tb-test:t3]')).toBeNull()
  expect(testInline('/budget try short [tb-test:t3]')).toBeNull()
})

test('testInline reads the task of a side session', async () => {
  const brief = 'Background (from the session that started this one): a test of the mod.\nTask:\n/budget try 0.6 read the ten files [tb-test:t4]'
  expect(testInline(brief)).toEqual({ limit: 0.6, task: 'read the ten files [tb-test:t4]' })
  const noLimit = '<system-reminder>note</system-reminder>\nBackground text\nTask:\n/budget try read the ten files and list them [tb-test:t2]'
  expect(testInline(noLimit)).toEqual({ task: 'read the ten files and list them [tb-test:t2]' })
})
