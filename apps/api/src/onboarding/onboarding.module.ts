import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { ImportService } from './import.service';

@Module({ controllers: [OnboardingController], providers: [OnboardingService, ImportService], exports: [OnboardingService] })
export class OnboardingModule {}
