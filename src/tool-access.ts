export interface ToolAccessContext {
  isMain: boolean;
  controllerTriggered?: boolean;
}

export function hasControllerAccess(context: ToolAccessContext): boolean {
  return context.isMain || context.controllerTriggered === true;
}
