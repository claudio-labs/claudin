import { describe, expect, test } from 'bun:test'

import { scanSymbols } from 'src/tools/shared/codeOutline/scanSymbols.js'

describe('scanSymbols — Terraform / HCL', () => {
  test('resource, data, module, variable, output, provider blocks', () => {
    const src = [
      'resource "aws_instance" "web" {',
      '  ami = "ami-123"',
      '}',
      'data "aws_ami" "ubuntu" {',
      '  most_recent = true',
      '}',
      'module "vpc" {',
      '  source = "./vpc"',
      '}',
      'variable "name" {',
      '  type = string',
      '}',
      'output "result" {',
      '  value = "ok"',
      '}',
      'provider "aws" {',
      '  region = "us-east-1"',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'terraform')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName['aws_instance.web']).toMatchObject({ kind: 'class', depth: 0 })
    expect(byName['aws_ami.ubuntu']).toMatchObject({ kind: 'record', depth: 0 })
    expect(byName.vpc).toMatchObject({ kind: 'module', depth: 0 })
    expect(byName.name).toMatchObject({ kind: 'const', depth: 0 })
    expect(byName.result).toMatchObject({ kind: 'const', depth: 0 })
    expect(byName.aws).toMatchObject({ kind: 'interface', depth: 0 })
  })

  test('locals and terraform blocks', () => {
    const src = [
      'locals {',
      '  common_tags = { Env = "prod" }',
      '}',
      'terraform {',
      '  required_version = ">= 1.0"',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'terraform')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName.locals).toMatchObject({ kind: 'module', depth: 0 })
    expect(byName.terraform).toMatchObject({ kind: 'module', depth: 0 })
  })

  test('nested blocks are methods at depth 1', () => {
    const src = [
      'resource "aws_instance" "web" {',
      '  dynamic "ebs_block_device" {',
      '    for_each = var.devices',
      '  }',
      '  provisioner "local-exec" {',
      '    command = "echo done"',
      '  }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'terraform')
    const methods = syms.filter(s => s.kind === 'method')
    expect(methods.length).toBeGreaterThanOrEqual(2)
    const names = methods.map(s => s.name)
    expect(names).toContain('ebs_block_device')
    expect(names).toContain('local-exec')
  })

  test('comments and heredocs are masked', () => {
    const src = [
      '# comment',
      'resource "x" "y" {',
      '  body = <<EOF',
      '    not a block',
      '  EOF',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'terraform')
    const names = syms.map(s => s.name)
    expect(names).toContain('x.y')
    expect(names).not.toContain('not')
  })

  test('empty fails open', () => {
    expect(scanSymbols('', 'terraform')).toEqual([])
    expect(scanSymbols('# only comments\n', 'terraform')).toEqual([])
  })
})

// Regression fixes from the PR #28 review pass — each test guards one
// verified scanner bug (see the PR discussion for the failure scenarios).
