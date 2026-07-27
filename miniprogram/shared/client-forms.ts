export function clearedFoundCardFields() {
  return {
    name: '',
    studentNumber: '',
    foundDate: '',
    feature: '',
    photoPath: '',
    storagePhotoPath: '',
    pickupDetail: '',
    storageDetail: '',
  }
}

export function clearedLostRegistrationFields() {
  return {
    lostDate: '',
    lostLocation: '',
    lostFeature: '',
  }
}

export function clearedProfileIdentityFields() {
  return {
    name: '',
    studentNumber: '',
    correctionReason: '',
  }
}

export function clearedClaimDisclosure() {
  return {
    claimedCardId: '',
    informationRevealed: false,
    revealedStoragePhotoUrl: '',
    revealedStoragePoint: '',
  }
}

export function canSubmitDeletionRequest(
  status: 'pending' | 'approved' | 'processing' | 'completed' | 'rejected' | null,
): boolean {
  return status === null || status === 'rejected'
}
