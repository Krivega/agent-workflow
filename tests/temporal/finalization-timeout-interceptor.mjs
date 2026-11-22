export function interceptors() {
  return {
    outbound: [
      {
        scheduleActivity(input, next) {
          return next(
            input.activityType === 'archiveFinalizedTask'
              ? { ...input, options: { ...input.options, startToCloseTimeout: '1 second' } }
              : input,
          );
        },
      },
    ],
  };
}
