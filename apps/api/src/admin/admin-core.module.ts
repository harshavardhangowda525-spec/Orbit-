import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MaintenanceGuard, StatusController } from './maintenance';
import { MessagingService, OwnerMessageTrackingController } from './messaging.service';
import { AdminOpsService } from './admin-ops.service';

/** Owner messaging and the admin engine, used by billing and jobs as well as the admin centre. */
@Global()
@Module({
  controllers: [OwnerMessageTrackingController, StatusController],
  providers: [MessagingService, AdminOpsService, { provide: APP_GUARD, useClass: MaintenanceGuard }],
  exports: [MessagingService, AdminOpsService],
})
export class AdminCoreModule {}
