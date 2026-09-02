import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MaskResponseInterceptor } from './interceptors/mask-response.interceptor';
import { SensitivityRegistry } from './sensitivity.registry';

@Module({
  providers: [
    SensitivityRegistry,
    // Registered here rather than in AppModule: a global interceptor is built
    // in the context of the module that declares it, and this one needs
    // SensitivityRegistry, which lives alongside it.
    { provide: APP_INTERCEPTOR, useClass: MaskResponseInterceptor },
  ],
  exports: [SensitivityRegistry],
})
export class MaskModule {}
