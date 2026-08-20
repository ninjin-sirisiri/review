export const ERROR_CODES = {
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_RECORD: "INVALID_RECORD",
  REPOSITORY_NOT_REGISTERED: "REPOSITORY_NOT_REGISTERED",
  PATH_OUTSIDE_ROOT: "PATH_OUTSIDE_ROOT",
  REVISION_NOT_FOUND: "REVISION_NOT_FOUND",
  HASH_MISMATCH: "HASH_MISMATCH",
  SOURCE_UNAVAILABLE: "SOURCE_UNAVAILABLE",
  DUPLICATE_RECORD: "DUPLICATE_RECORD",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ApiSuccess<T> {
  success: true;
  data: T;
}

export interface ApiErrorDetail {
  field?: string;
  message: string;
}

export interface ApiFailure {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    field?: string;
    details?: ApiErrorDetail[];
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
