import {
  IdentityEmailPayloadError,
  parseIdentityEmail,
} from './identity-email-message.util';

const payload = (over: Record<string, unknown> = {}) => ({
  contextInfo: {
    recipientEmailAddress: 'Visitor@Example.com',
    eventType: 'user.human.email.code.added',
    provider: { id: 'p1', description: 'Flui mail' },
  },
  templateData: {
    title: 'Verify email',
    preHeader: 'Verify email',
    subject: 'Verify email',
    greeting: 'Hello Ada &amp; Co,',
    text: 'Please use the button below to verify your email. (Code ABC123)',
    url: 'https://auth.example.com/verify?code=ABC123',
    buttonText: 'Verify email',
    primaryColor: '#123456',
    backgroundColor: '#fafafa',
    fontColor: '#22292f',
    fontFamily: 'Arial',
  },
  args: { code: 'ABC123', displayName: 'Ada & Co' },
  ...over,
});

describe('reading a message from the identity provider', () => {
  it('takes the recipient from the context and the pieces from the template data', () => {
    const message = parseIdentityEmail(payload());
    expect(message.to).toBe('visitor@example.com');
    expect(message.subject).toBe('Verify email');
    expect(message.eventType).toBe('user.human.email.code.added');
    expect(message.text).toContain('Hello Ada & Co,');
    expect(message.text).toContain('(Code ABC123)');
    expect(message.text).toContain(
      'Verify email: https://auth.example.com/verify?code=ABC123',
    );
    expect(message.html).toContain('Hello Ada &amp; Co,');
    expect(message.html).toContain(
      'href="https://auth.example.com/verify?code=ABC123"',
    );
    expect(message.html).toContain('background:#123456');
  });

  it('escapes markup in the text and keeps line breaks', () => {
    const message = parseIdentityEmail(
      payload({
        templateData: {
          subject: 'Hi',
          text: 'Line one<br/>Line &lt;b&gt;two&lt;/b&gt;<script>x</script>',
        },
      }),
    );
    expect(message.html).toContain('Line one<br>Line two');
    expect(message.html).not.toContain('<script>');
    expect(message.text).toBe('Line one\nLine twox');
  });

  it('drops a link that is not http(s) and a colour that is not a colour', () => {
    const message = parseIdentityEmail(
      payload({
        templateData: {
          subject: 'Hi',
          text: 'x',
          url: 'javascript:alert(1)',
          primaryColor: 'red;background:url(x)',
        },
      }),
    );
    expect(message.html).not.toContain('javascript:');
    expect(message.html).not.toContain('url(x)');
    expect(message.html).not.toContain('<a ');
  });

  it('includes the footer only when the identity provider says so', () => {
    const without = parseIdentityEmail(
      payload({ templateData: { subject: 'Hi', footerText: 'Footer' } }),
    );
    expect(without.text).not.toContain('Footer');
    const withFooter = parseIdentityEmail(
      payload({
        templateData: {
          subject: 'Hi',
          footerText: 'Footer',
          includeFooter: true,
        },
      }),
    );
    expect(withFooter.text).toContain('Footer');
  });

  it('refuses a message without a recipient, a subject, or a body at all', () => {
    expect(() =>
      parseIdentityEmail(payload({ contextInfo: { eventType: 'x' } })),
    ).toThrow(IdentityEmailPayloadError);
    expect(() =>
      parseIdentityEmail(
        payload({ contextInfo: { recipientEmailAddress: 'not-an-address' } }),
      ),
    ).toThrow(IdentityEmailPayloadError);
    expect(() =>
      parseIdentityEmail(payload({ templateData: { text: 'x' } })),
    ).toThrow(IdentityEmailPayloadError);
    expect(() => parseIdentityEmail(null)).toThrow(IdentityEmailPayloadError);
    expect(() => parseIdentityEmail([])).toThrow(IdentityEmailPayloadError);
  });
});
