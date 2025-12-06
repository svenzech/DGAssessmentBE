// src/server/util/errors.ts

export class HttpError extends Error {
  status: number;
  details?: any;

  constructor(status: number, message: string, details?: any) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export class BadRequestError extends HttpError {
  constructor(message = 'Bad Request', details?: any) {
    super(400, message, details);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'Unauthorized', details?: any) {
    super(401, message, details);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'Forbidden', details?: any) {
    super(403, message, details);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = 'Not Found', details?: any) {
    super(404, message, details);
  }
}

export class InternalServerError extends HttpError {
  constructor(message = 'Internal Server Error', details?: any) {
    super(500, message, details);
  }
}