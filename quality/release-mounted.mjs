export async function withMountedDiskImage({
  action,
  cleanupMountPoint = async () => {},
  cleanupRun,
  image,
  mountPoint,
  run,
}) {
  const cleanup = cleanupRun ?? run;
  let failure;
  let result;
  let attachStarted = false;
  try {
    attachStarted = true;
    await run("hdiutil", [
      "attach",
      "-quiet",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mountPoint,
      image,
    ]);
    result = await action(mountPoint);
  } catch (error) {
    failure = error;
  }
  const cleanupFailures = [];
  if (attachStarted)
    try {
      await cleanup("hdiutil", ["detach", "-quiet", mountPoint]);
    } catch (error) {
      try {
        await cleanup("hdiutil", ["detach", "-quiet", "-force", mountPoint]);
      } catch (forcedError) {
        cleanupFailures.push(error, forcedError);
      }
    }
  try {
    await cleanupMountPoint(mountPoint);
  } catch (error) {
    cleanupFailures.push(error);
  }
  if (cleanupFailures.length > 0)
    throw new AggregateError(
      failure === undefined ? cleanupFailures : [failure, ...cleanupFailures],
      failure === undefined
        ? "release-cleanup-failed"
        : "release-inspection-cleanup-failed",
    );
  if (failure !== undefined) throw failure;
  return result;
}
