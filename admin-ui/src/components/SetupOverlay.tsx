import { CModal, CModalBody } from '@coreui/react';

import { SetupWizard } from '../setup/SetupWizard';

export function SetupOverlay(props: { visible: boolean }) {
  return (
    <CModal
      visible={props.visible}
      backdrop="static"
      alignment="center"
      className="setupOverlayDialog"
    >
      <CModalBody className="setupOverlayPanel">
        <div className="setupOverlayHeader">
          <span className="heroEyebrow">First-run setup</span>
          <h2>Finish setup before the control plane unlocks</h2>
          <p>
            This stays on top until the core model, Signal bridge, and trust controls
            are configured.
          </p>
        </div>
        <SetupWizard />
      </CModalBody>
    </CModal>
  );
}
