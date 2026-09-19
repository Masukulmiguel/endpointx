import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

interface ValidationErrorDetail {
  field: string;
  message: string;
  code?: string;
}

interface ValidationErrorResponse {
  success: false;
  error: {
    message: string;
    code: string;
    details: ValidationErrorDetail[];
  };
}

function formatZodErrors(error: ZodError): ValidationErrorDetail[] {
  return error.errors.map((err) => ({
    field: err.path.join('.'),
    message: err.message,
    code: err.code,
  }));
}

function handleValidationError(
  res: Response,
  errors: ValidationErrorDetail[]
): void {
  const response: ValidationErrorResponse = {
    success: false,
    error: {
      message: 'Request validation failed',
      code: 'VALIDATION_ERROR',
      details: errors,
    },
  };

  res.status(400).json(response);
}

function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const errors = formatZodErrors(result.error);
      handleValidationError(res, errors);
      return;
    }

    req.body = result.data;
    next();
  };
}

function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      const errors = formatZodErrors(result.error);
      handleValidationError(res, errors);
      return;
    }

    req.query = result.data as any;
    next();
  };
}

function validateParams(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      const errors = formatZodErrors(result.error);
      handleValidationError(res, errors);
      return;
    }

    req.params = result.data as any;
    next();
  };
}

export { validate, validateQuery, validateParams };
