import { SetMetadata } from '@nestjs/common';

export const DATA_DOOR_KEY = 'iam:dataDoor';

/**
 * This route reaches the data of an application — a log, a value, a console, a
 * shell, a restore. It then also needs `data:access`, on top of whatever else
 * it asks for, and every call is recorded as a read of data.
 */
export const DataDoor = () => SetMetadata(DATA_DOOR_KEY, true);
