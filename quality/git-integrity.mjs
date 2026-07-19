const noReplaceOption = "--no-replace-objects";

export function hardenedGitArguments(args) {
  if (!Array.isArray(args)) throw new Error("git-integrity-arguments");
  return args[0] === noReplaceOption ? [...args] : [noReplaceOption, ...args];
}

export function noReplaceGitEnvironment(environment = process.env) {
  return { ...environment, GIT_NO_REPLACE_OBJECTS: "1" };
}
