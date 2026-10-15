import {
  LOGIN_TEXTS_REVISION,
  brandText,
  planLoginTexts,
  planMessageText,
} from './oidc-login-texts';

describe('sign-in texts', () => {
  it('names Flui instead of the provider, whatever the case', () => {
    expect(brandText('Usa il tuo account Zitadel')).toBe(
      'Usa il tuo account Flui',
    );
    expect(brandText('Use your ZITADEL account')).toBe('Use your Flui account');
    expect(brandText('zitadel user')).toBe('Flui user');
    expect(brandText('Zitadelアカウントを使用します。')).toBe(
      'Fluiアカウントを使用します。',
    );
    expect(brandText('Използвайте вашия Zitadel-акаунт')).toBe(
      'Използвайте вашия Flui-акаунт',
    );
    expect(brandText('con un utente Zitadel.')).toBe('con un utente Flui.');
  });

  it('leaves addresses and DNS names alone', () => {
    expect(brandText('See https://zitadel.com/docs')).toBe(
      'See https://zitadel.com/docs',
    );
    expect(brandText('the _zitadel-challenge record')).toBe(
      'the _zitadel-challenge record',
    );
    expect(brandText('mail ops@zitadel.ch')).toBe('mail ops@zitadel.ch');
  });

  it('sets only what changes and lets every other default follow the provider', () => {
    const plan = planLoginTexts(
      'it',
      {
        details: { sequence: '1' },
        isDefault: true,
        selectAccountText: {
          title: "Seleziona l'account",
          description: 'Usa il tuo account Zitadel',
        },
        loginText: {
          title: 'Bentornato!',
          registerButtonText: 'registrare',
          nextButtonText: 'Avanti',
        },
      },
      { isDefault: true, loginText: { title: 'Bentornato!' } },
    );
    expect(plan?.body).toEqual({
      selectAccountText: { description: 'Usa il tuo account Flui' },
      loginText: { registerButtonText: 'Registrati' },
    });
    expect(plan?.changed).toEqual([
      'selectAccountText.description',
      'loginText.registerButtonText',
    ]);
  });

  it("keeps the organisation's own wording, rewritten, and never overrides it with a fix", () => {
    const plan = planLoginTexts(
      'it',
      {
        loginText: {
          title: 'Bentornato!',
          registerButtonText: 'registrare',
        },
      },
      {
        isDefault: false,
        loginText: {
          title: 'Benvenuto in Zitadel',
          registerButtonText: 'Crea un account',
        },
      },
    );
    expect(plan?.body).toEqual({
      loginText: {
        title: 'Benvenuto in Flui',
        registerButtonText: 'Crea un account',
      },
    });
    expect(plan?.changed).toEqual(['loginText.title']);
  });

  it('applies the Italian fixes to Italian only', () => {
    const defaults = { loginText: { registerButtonText: 'registrare' } };
    expect(planLoginTexts('en', defaults, {})).toBeNull();
  });

  it('changes nothing once the texts are in place', () => {
    const defaults = {
      selectAccountText: { description: 'Usa il tuo account Zitadel' },
      loginText: { registerButtonText: 'registrare', title: 'Bentornato!' },
    };
    const first = planLoginTexts('it', defaults, {});
    expect(first).not.toBeNull();
    expect(
      planLoginTexts('it', defaults, { isDefault: false, ...first!.body }),
    ).toBeNull();
  });

  it('rewrites the email texts Flui renders, subject and body included', () => {
    const plan = planMessageText(
      {
        isDefault: true,
        title: "Zitadel - Inizializzare l'utente",
        preHeader: "Inizializzare l'utente",
        subject: "Inizializzare l'utente",
        greeting: 'Ciao {{.DisplayName}},',
        text: 'Questo utente è stato creato in Zitadel. (Codice {{.Code}})',
        buttonText: 'Termina',
        footerText: '',
      },
      { isDefault: true, title: "Zitadel - Inizializzare l'utente" },
    );
    expect(plan?.body).toEqual({
      title: "Flui - Inizializzare l'utente",
      text: 'Questo utente è stato creato in Flui. (Codice {{.Code}})',
    });
  });

  it('sends nothing for an email that never names the provider', () => {
    expect(
      planMessageText(
        { title: 'Reset password', subject: 'Reset password', text: 'Hi' },
        null,
      ),
    ).toBeNull();
  });

  it('has a revision the branding version follows', () => {
    expect(LOGIN_TEXTS_REVISION).toMatch(/^[0-9a-f]{12}$/);
  });
});
