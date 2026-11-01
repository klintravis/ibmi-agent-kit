## MODIFIED Requirements

### Requirement: Parameters are typed and safe to substitute
Parameters SHALL declare a type (`string`, `name`, `integer`, `decimal`, `date`, `boolean`) and may
declare `required`, `default` and `allowed`. `:name` in SQL SHALL be sent as a bound parameter.
`${name}` SHALL be text substitution, allowed only for parameters with `allowed` or of the `name`,
integer, decimal, date or boolean type, validated before substitution. A `${name}` reference that
breaks this rule SHALL refuse the verb at load.

#### Scenario: String parameter in text
- **WHEN** a verb uses `${env}` and `env` is a string with no `allowed`
- **THEN** the verb is refused at load, naming the parameter

#### Scenario: Value outside allowed
- **WHEN** `verb_run` passes `env: PRD` and `allowed` is `[IN1, IN2]`
- **THEN** the call fails before anything is sent

#### Scenario: Name parameter in CL
- **WHEN** a verb's CL step is `CMPRD/CMCHKOUT TASK(${task}) MBR(${member})` and `member` has type `name`
- **THEN** the verb loads, and `verb_run` with `member: ordval` sends `MBR(ORDVAL)`

#### Scenario: Name is an object name
- **WHEN** a `name` argument is `A'B`, `A B`, `A(B)`, `A&B`, `A,B`, an empty string, a name starting with a digit or one of 11 characters
- **THEN** the call fails before anything is sent, naming the parameter

#### Scenario: Name with allowed
- **WHEN** a `name` parameter has `allowed: [ordhdr]`
- **THEN** `ORDHDR` and `ordhdr` are accepted and anything else is refused, and an `allowed` value that is not a name refuses the verb at load

#### Scenario: Name that is a production library
- **WHEN** a verb's CL step is `CHGDTAARA DTAARA(${lib}/DA) VALUE('X')` with `lib` of type `name` and a call passes a library that an environment rule denies
- **THEN** the guard denies the substituted statement like a literal one
