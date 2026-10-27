'use strict';

/** Entrada inválida ou regra de negócio violada; a camada HTTP converte em 400. */
class ValidationError extends Error {}

/** Operação válida, mas incompatível com o estado atual (ex.: saldo insuficiente); vira 409. */
class ConflictError extends Error {}

module.exports = { ValidationError, ConflictError };
