function risky() returns int|error { return 1; }
 public function main() returns error? {
   int|error captured = trap checkpanic risky();
   int checked = check (trap risky());
   string message = string `value ${check risky()}`;
 _ = captured; _ = checked; _ = message;
 }