import { Global, Module } from '@nestjs/common';
import { BookingsController, PublicBookingController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { NudgeModule } from '../nudge/nudge.service';

@Global()
@Module({ imports: [NudgeModule], controllers: [BookingsController, PublicBookingController], providers: [BookingsService], exports: [BookingsService, NudgeModule] })
export class BookingsModule {}
