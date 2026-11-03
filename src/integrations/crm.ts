import { z } from 'zod';
import { requestJson, type RequestOptions } from './http.js';

export interface CrmContact {
  id: string;
  phone: string | null;
  mobilephone: string | null;
  email: string | null;
  firstname: string | null;
  createdAt: string | null;
}

export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH';

export interface CrmTicket {
  id: string;
  subject: string;
  priority: TicketPriority;
  contactId: string | null;
  createdAt: string;
}

export interface ContactProps {
  phone?: string;
  email?: string;
  firstname?: string;
}

export interface CrmClient {
  readonly mock: boolean;
  searchContacts(criteria: { phones: string[]; email?: string }): Promise<CrmContact[]>;
  createContact(props: ContactProps): Promise<CrmContact>;
  updateContact(id: string, props: ContactProps): Promise<CrmContact>;
  /** Creates a support ticket (never a deal) associated with the contact. */
  createTicket(input: { subject: string; content: string; priority: TicketPriority; contactId: string | null }): Promise<CrmTicket>;
}

// ---------------------------------------------------------------------------
// HubSpot CRM v3 objects API, authenticated with a private app access token.
// Required scopes: crm.objects.contacts.read, crm.objects.contacts.write, tickets.
// ---------------------------------------------------------------------------

const CONTACT_PROPERTIES = ['phone', 'mobilephone', 'email', 'firstname', 'createdate'];
/** HubSpot-defined association type id for ticket → contact. */
export const TICKET_TO_CONTACT_ASSOCIATION_TYPE_ID = 16;

const hsObject = z.object({
  id: z.string(),
  createdAt: z.string().optional(),
  properties: z.record(z.string().nullable()).default({}),
});

function toContact(raw: unknown): CrmContact {
  const o = hsObject.parse(raw);
  return {
    id: o.id,
    phone: o.properties.phone ?? null,
    mobilephone: o.properties.mobilephone ?? null,
    email: o.properties.email ?? null,
    firstname: o.properties.firstname ?? null,
    createdAt: o.properties.createdate ?? o.createdAt ?? null,
  };
}

export class HubSpotClient implements CrmClient {
  readonly mock = false;

  constructor(
    private readonly opts: {
      accessToken: string;
      baseUrl: string;
      ticketPipeline: string;
      ticketStage: string;
      http?: Pick<RequestOptions, 'fetchImpl' | 'sleep'>;
    },
  ) {}

  private req<T>(path: string, init: RequestOptions) {
    return requestJson<T>('hubspot', `${this.opts.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.opts.accessToken}`, ...init.headers },
      ...this.opts.http,
    });
  }

  async searchContacts(criteria: { phones: string[]; email?: string }): Promise<CrmContact[]> {
    // HubSpot allows up to 5 filterGroups (OR-ed). Phone formats in CRMs vary, so search the
    // same number with and without "+" on both phone fields.
    const groups = criteria.phones
      .flatMap((p) => [
        { filters: [{ propertyName: 'phone', operator: 'EQ', value: p }] },
        { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: p }] },
      ])
      .slice(0, criteria.email ? 4 : 5);
    if (criteria.email) groups.push({ filters: [{ propertyName: 'email', operator: 'EQ', value: criteria.email }] });
    if (groups.length === 0) return [];
    const data = await this.req<{ results?: unknown[] }>('/crm/v3/objects/contacts/search', {
      method: 'POST',
      idempotent: true, // search is read-only
      body: { filterGroups: groups, properties: CONTACT_PROPERTIES, sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }], limit: 10 },
    });
    return (data?.results ?? []).map(toContact);
  }

  async createContact(props: ContactProps): Promise<CrmContact> {
    const data = await this.req<unknown>('/crm/v3/objects/contacts', { method: 'POST', body: { properties: clean(props) } });
    return toContact(data);
  }

  async updateContact(id: string, props: ContactProps): Promise<CrmContact> {
    const data = await this.req<unknown>(`/crm/v3/objects/contacts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      idempotent: true, // setting the same properties twice has the same effect
      body: { properties: clean(props) },
    });
    return toContact(data);
  }

  async createTicket(input: { subject: string; content: string; priority: TicketPriority; contactId: string | null }): Promise<CrmTicket> {
    const body: Record<string, unknown> = {
      properties: {
        subject: input.subject.slice(0, 250),
        content: input.content.slice(0, 5000),
        hs_pipeline: this.opts.ticketPipeline,
        hs_pipeline_stage: this.opts.ticketStage,
        hs_ticket_priority: input.priority,
      },
    };
    if (input.contactId) {
      body.associations = [
        {
          to: { id: input.contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: TICKET_TO_CONTACT_ASSOCIATION_TYPE_ID }],
        },
      ];
    }
    const data = await this.req<unknown>('/crm/v3/objects/tickets', { method: 'POST', body });
    const o = hsObject.parse(data);
    return {
      id: o.id,
      subject: input.subject,
      priority: input.priority,
      contactId: input.contactId,
      createdAt: o.createdAt ?? new Date().toISOString(),
    };
  }
}

function clean(props: ContactProps): Record<string, string> {
  return Object.fromEntries(Object.entries(props).filter(([, v]) => typeof v === 'string' && v.length > 0)) as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Mock HubSpot (DEMO_MODE). Keeps contacts/tickets in memory and records every
// operation so the dashboard can show exactly what would have been written.
// ---------------------------------------------------------------------------

export interface CrmOperation {
  at: string;
  op: 'search' | 'create_contact' | 'update_contact' | 'create_ticket';
  objectId?: string;
  detail: string;
}

export class MockCrmClient implements CrmClient {
  readonly mock = true;
  contacts: CrmContact[] = [];
  tickets: CrmTicket[] = [];
  operations: CrmOperation[] = [];
  /** Simulates HubSpot search indexing lag: new contacts are invisible to search for this long. */
  searchIndexLagMs = 0;
  failNext: Partial<Record<CrmOperation['op'], Error>> = {};
  private seq = 0;
  private readonly visibleAt = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  private log(op: CrmOperation['op'], detail: string, objectId?: string) {
    this.operations.push({ at: new Date(this.now()).toISOString(), op, detail, objectId });
    if (this.operations.length > 200) this.operations.shift();
  }

  private maybeFail(op: CrmOperation['op']) {
    const err = this.failNext[op];
    if (err) {
      delete this.failNext[op];
      throw err;
    }
  }

  async searchContacts(criteria: { phones: string[]; email?: string }): Promise<CrmContact[]> {
    this.maybeFail('search');
    const now = this.now();
    const results = this.contacts.filter(
      (c) =>
        (this.visibleAt.get(c.id) ?? 0) <= now &&
        (criteria.phones.some((p) => p === c.phone || p === c.mobilephone) || (criteria.email !== undefined && criteria.email === c.email)),
    );
    this.log('search', `contacts search → ${results.length} match(es)`);
    return structuredClone(results);
  }

  async createContact(props: ContactProps): Promise<CrmContact> {
    this.maybeFail('create_contact');
    const contact: CrmContact = {
      id: `mock-contact-${++this.seq}`,
      phone: props.phone ?? null,
      mobilephone: null,
      email: props.email ?? null,
      firstname: props.firstname ?? null,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.contacts.push(contact);
    this.visibleAt.set(contact.id, this.now() + this.searchIndexLagMs);
    this.log('create_contact', `created contact ${contact.id}`, contact.id);
    return structuredClone(contact);
  }

  async updateContact(id: string, props: ContactProps): Promise<CrmContact> {
    this.maybeFail('update_contact');
    const contact = this.contacts.find((c) => c.id === id);
    if (!contact) throw new Error(`mock contact ${id} not found`);
    Object.assign(contact, clean(props));
    this.log('update_contact', `updated ${Object.keys(clean(props)).join(', ') || 'nothing'} on ${id}`, id);
    return structuredClone(contact);
  }

  async createTicket(input: { subject: string; content: string; priority: TicketPriority; contactId: string | null }): Promise<CrmTicket> {
    this.maybeFail('create_ticket');
    const ticket: CrmTicket = {
      id: `mock-ticket-${++this.seq}`,
      subject: input.subject,
      priority: input.priority,
      contactId: input.contactId,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.tickets.push(ticket);
    this.log('create_ticket', `ticket "${input.subject}" (${input.priority}) → contact ${input.contactId ?? 'none'}`, ticket.id);
    return structuredClone(ticket);
  }

  reset() {
    this.contacts = [];
    this.tickets = [];
    this.operations = [];
    this.visibleAt.clear();
    this.seq = 0;
  }
}
