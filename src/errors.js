export class AxiError extends Error {
  constructor(message, { help, exitCode = 1, status } = {}) {
    super(message);
    this.name = "AxiError";
    this.help = help;
    this.exitCode = exitCode;
    this.status = status;
  }
}

export class UsageError extends AxiError {
  constructor(message, help) {
    super(message, { help, exitCode: 2 });
    this.name = "UsageError";
  }
}
